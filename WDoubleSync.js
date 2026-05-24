import DoubleSync from 'doublesync';
import {
    CDCStore,
    DoubleSyncSnapshot,
    DoubleSyncPatch,
    DoubleSyncDiffPatch,
    DoubleSyncCompressed,
    DoubleSyncFormat,
    DoubleSyncMemoryFolder,
} from 'doublesync';

/**
 * Combines EndlessVector (on-chain append-only storage on Sui) with DoubleSync
 * (CDC-based folder-tree delta sync) to store snapshots and patches on-chain and
 * reconstruct folder state from the chain.
 *
 * Each EndlessVector item holds one patch document — either a full `DoubleSyncPatch`
 * (item 0) or an incremental `DoubleSyncDiffPatch` (items 1..N). The document type
 * is auto-detected via the magic header (`DoubleSyncFormat.detect`).
 *
 * Sender workflow:
 *   const w = new WDoubleSync({ endlessVector, sync });
 *   await w.initialize();
 *   await w.push(senderRoot);          // first  → full patch
 *   await w.push(senderRoot);          // next   → diff patch
 *
 * Receiver workflow:
 *   const w = new WDoubleSync({ endlessVector });
 *   const folder = await w.restore();  // latest version
 *   const older  = await w.restore(2); // specific version
 *
 * @example
 * import EndlessVector from 'endless_vector';
 * import DoubleSync from 'doublesync';
 * import WDoubleSync from './WDoubleSync.js';
 *
 * const ev = new EndlessVector({ suiClient, id, packageId, signAndExecuteTransaction });
 * const sync = new DoubleSync({ avgSize: 8192 });
 * const w = new WDoubleSync({ endlessVector: ev, sync });
 * await w.initialize();
 * await w.push(senderRoot);
 */
export default class WDoubleSync {
    /**
     * @param {Object} params
     * @param {import('endless_vector').default} params.endlessVector - EndlessVector instance (read or read+write)
     * @param {DoubleSync} [params.sync] - DoubleSync instance; defaults to `new DoubleSync()` if omitted
     * @param {'gzip'|false} [params.compress=false] - wrap patches in a compression envelope before pushing
     */
    constructor(params = {}) {
        if (!params.endlessVector) throw new Error('WDoubleSync: endlessVector is required');

        /** @type {import('endless_vector').default} */
        this._ev = params.endlessVector;
        /** @type {DoubleSync} */
        this._sync = params.sync || new DoubleSync();
        /** @type {?'gzip'} */
        this._compress = params.compress || null;

        /** @type {CDCStore} */
        this._senderStore = new CDCStore();
        /** @type {CDCStore} */
        this._receiverMirror = new CDCStore();

        /** @type {?Uint8Array} - snapshot bytes from the last patch produced or replayed */
        this._lastSnapshot = null;
        /** @type {number} - how many items from chain have been replayed into _senderStore / _lastSnapshot */
        this._replayedCount = 0;

        /** @type {boolean} */
        this._isInitialized = false;
    }

    /**
     * Number of patch versions stored on chain.
     * @returns {Promise<number>}
     */
    async length() {
        await this._ev.initialize();
        return this._ev.length;
    }

    /**
     * Initialize: load EndlessVector state and rebuild CDCStore + session state
     * by replaying every existing item from the chain.
     *
     * Safe to call multiple times — skips items already replayed.
     * @returns {Promise<void>}
     */
    async initialize() {
        await this._ev.initialize();

        const total = this._ev.length;

        // Replay items we haven't seen yet
        if (this._replayedCount < total) {
            await this._replayRange(this._replayedCount, total);
        }

        this._isInitialized = true;
    }

    /**
     * Re-initialize: force reload from chain. Useful after external pushes.
     */
    reInitialize() {
        this._ev.reInitialize();
        this._senderStore = new CDCStore();
        this._receiverMirror = new CDCStore();
        this._lastSnapshot = null;
        this._replayedCount = 0;
        this._isInitialized = false;
    }

    /**
     * Build the next patch from `root` and push it to the EndlessVector.
     *
     * First push produces a full `DoubleSyncPatch`; every subsequent push
     * produces a `DoubleSyncDiffPatch` against the previous snapshot.
     *
     * @param {import('doublesync').DoubleSyncFolder} root - sender's current folder tree
     * @param {Object} [params]
     * @param {number} [params.timeout] - tx confirmation timeout in ms
     * @param {number} [params.pollIntervalMs] - tx poll interval in ms
     * @returns {Promise<{version: number}>}
     */
    async push(root, params = {}) {
        if (!this._isInitialized) await this.initialize();

        let patchBytes;
        let newSnapshot = null;
        let newChunks = [];

        if (!this._lastSnapshot) {
            patchBytes = await this._sync.buildPatch({
                root,
                senderStore: this._senderStore,
                receiverStore: this._receiverMirror,
            });

            const parsed = new DoubleSyncPatch(patchBytes);
            newSnapshot = parsed.snapshot.slice();

            for (const { hash, bytes } of parsed.chunks()) {
                newChunks.push({ hash, bytes });
            }
        } else {
            const result = await this._sync.buildDiffPatch({
                root,
                senderStore: this._senderStore,
                receiverStore: this._receiverMirror,
                prevSnapshot: this._lastSnapshot,
            });
            patchBytes = result.patch;
            newSnapshot = result.newSnapshot;

            const parsedDiff = new DoubleSyncDiffPatch(patchBytes);
            for (const { hash, bytes } of parsedDiff.chunks()) {
                newChunks.push({ hash, bytes });
            }
        }

        if (this._compress) {
            patchBytes = await DoubleSyncCompressed.encode(patchBytes, this._compress);
        }

        await this._ev.push(patchBytes, params);

        this._lastSnapshot = newSnapshot;
        for (const { hash, bytes } of newChunks) {
            this._receiverMirror.putWithHash(hash, bytes);
        }
        this._replayedCount++;

        return { version: this._replayedCount };
    }

    /**
     * Read raw patch bytes at the given chain index.
     *
     * @param {number} index
     * @returns {Promise<Uint8Array>}
     */
    async getPatch(index) {
        await this._ev.initialize();
        return await this._ev.at(index);
    }

    /**
     * Reconstruct the folder tree by replaying patches 0..version from the chain.
     * Returns a `DoubleSyncMemoryFolder` containing the reconstructed tree.
     *
     * @param {number} [version] - replay up to this version (exclusive); defaults to latest
     * @returns {Promise<DoubleSyncMemoryFolder>}
     */
    async restore(version) {
        await this._ev.initialize();

        const total = this._ev.length;
        const end = (version !== undefined) ? Math.min(version, total) : total;

        if (end === 0) return new DoubleSyncMemoryFolder('root');

        const store = new CDCStore();
        const dest = new DoubleSyncMemoryFolder('root');
        let lastSnapshot = null;

        for (let i = 0; i < end; i++) {
            let patchBytes = await this._ev.at(i);

            if (DoubleSyncFormat.isCompressed(patchBytes)) {
                patchBytes = await DoubleSyncCompressed.decode(patchBytes);
            }

            const kind = DoubleSyncFormat.detect(patchBytes);

            if (kind === 'patch') {
                await this._sync.applyPatch({ patch: patchBytes, store, dest });
                const parsed = new DoubleSyncPatch(patchBytes);
                lastSnapshot = parsed.snapshot.slice();
            } else if (kind === 'diff-patch') {
                if (!lastSnapshot) {
                    throw new Error(`WDoubleSync.restore: diff-patch at index ${i} but no prior snapshot`);
                }
                const newSnapshot = await this._sync.applyDiffPatch({
                    patch: patchBytes,
                    store,
                    dest,
                    prevSnapshot: lastSnapshot,
                });
                lastSnapshot = newSnapshot;
            } else {
                throw new Error(`WDoubleSync.restore: unknown patch type at index ${i}`);
            }
        }

        return dest;
    }

    /**
     * Replay items from the chain into _senderStore and _lastSnapshot so the sender
     * session state is up to date for the next push().
     *
     * @param {number} from - inclusive start index
     * @param {number} to - exclusive end index
     */
    async _replayRange(from, to) {
        // We need a temporary dest to drive applyPatch / applyDiffPatch, but we only
        // care about the CDCStore and snapshot state — not the folder contents. A
        // throwaway memory folder is cheap.
        const dest = new DoubleSyncMemoryFolder('_replay');

        for (let i = from; i < to; i++) {
            let patchBytes = await this._ev.at(i);

            if (DoubleSyncFormat.isCompressed(patchBytes)) {
                patchBytes = await DoubleSyncCompressed.decode(patchBytes);
            }

            const kind = DoubleSyncFormat.detect(patchBytes);

            if (kind === 'patch') {
                await this._sync.applyPatch({ patch: patchBytes, store: this._senderStore, dest });

                const parsed = new DoubleSyncPatch(patchBytes);
                this._lastSnapshot = parsed.snapshot.slice();

                // Receiver mirror: after a full patch, receiver has all embedded chunks
                for (const { hash, bytes } of parsed.chunks()) {
                    this._receiverMirror.putWithHash(hash, bytes);
                }
            } else if (kind === 'diff-patch') {
                if (!this._lastSnapshot) {
                    throw new Error(`WDoubleSync._replayRange: diff-patch at index ${i} but no prior snapshot`);
                }
                const newSnapshot = await this._sync.applyDiffPatch({
                    patch: patchBytes,
                    store: this._senderStore,
                    dest,
                    prevSnapshot: this._lastSnapshot,
                });
                this._lastSnapshot = newSnapshot;

                const parsedDiff = new DoubleSyncDiffPatch(patchBytes);
                for (const { hash, bytes } of parsedDiff.chunks()) {
                    this._receiverMirror.putWithHash(hash, bytes);
                }
            } else {
                throw new Error(`WDoubleSync._replayRange: unknown patch type at index ${i}`);
            }
        }

        this._replayedCount = to;
    }
}
