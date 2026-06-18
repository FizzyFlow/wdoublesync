import {
    DoubleSync,
    CDCStore,
    DoubleSyncSnapshot,
    DoubleSyncPatch,
    DoubleSyncDiffPatch,
    DoubleSyncCompressed,
    DoubleSyncFormat,
    DoubleSyncMemoryFolder,
} from '@fizzyflow/doublesync';

const SEGMENT_MAGIC = 0x57445347; // WDSG
const SEGMENT_VERSION = 1;
const SEGMENT_HEADER_SIZE = 24;
const DEFAULT_MAX_PATCH_ITEM_BYTES = 8 * 1024 * 1024;

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
     * @param {number} [params.maxPatchItemBytes=8388608] - split larger patch documents across multiple vector items
     */
    constructor(params = {}) {
        if (!params.endlessVector) throw new Error('WDoubleSync: endlessVector is required');

        /** @type {import('endless_vector').default} */
        this._ev = params.endlessVector;
        /** @type {DoubleSync} */
        this._sync = params.sync || new DoubleSync();
        /** @type {?'gzip'} */
        this._compress = params.compress || null;
        /** @type {number} */
        this._maxPatchItemBytes = params.maxPatchItemBytes || DEFAULT_MAX_PATCH_ITEM_BYTES;

        /** @type {CDCStore} */
        this._senderStore = new CDCStore({ copyBytes: false });
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
        this._senderStore = new CDCStore({ copyBytes: false });
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

        this._senderStore = this._cloneReceiverMirror();
        const pushedItems = await this._pushPatchDocument(patchBytes, params);

        this._lastSnapshot = newSnapshot;
        for (const { hash, bytes } of newChunks) {
            this._receiverMirror.putWithHash(hash, bytes);
            this._senderStore.putWithHash(hash, bytes);
        }
        this._replayedCount += pushedItems;

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

        let store = new CDCStore({ copyBytes: false });
        let dest = new DoubleSyncMemoryFolder('root');
        let lastSnapshot = null;
        let invalidState = false;

        for (let i = 0; i < end;) {
            const item = await this._readPatchDocument(i, end);
            let patchBytes = item.patchBytes;
            i = item.nextIndex;

            if (DoubleSyncFormat.isCompressed(patchBytes)) {
                patchBytes = await DoubleSyncCompressed.decode(patchBytes);
            }

            const kind = DoubleSyncFormat.detect(patchBytes);

            if (kind === 'patch') {
                // Full snapshot — reset all state and use this as the new baseline.
                // This makes full snapshots act as recovery points: corrupt diffs
                // before this index are skipped.
                store = new CDCStore({ copyBytes: false });
                dest = new DoubleSyncMemoryFolder('root');
                await this._sync.applyPatch({ patch: patchBytes, store, dest });
                const parsed = new DoubleSyncPatch(patchBytes);
                lastSnapshot = parsed.snapshot.slice();
                invalidState = false;
            } else if (kind === 'diff-patch') {
                if (invalidState || !lastSnapshot) {
                    // In invalid state — skip this diff and wait for the next full snapshot.
                    continue;
                }
                try {
                    const newSnapshot = await this._sync.applyDiffPatch({
                        patch: patchBytes,
                        store,
                        dest,
                        prevSnapshot: lastSnapshot,
                    });
                    lastSnapshot = newSnapshot;
                } catch (_err) {
                    // Corrupt diff — enter invalid state and wait for next full snapshot.
                    invalidState = true;
                    lastSnapshot = null;
                }
            } else {
                throw new Error(`WDoubleSync.restore: unknown patch type at index ${i}`);
            }
        }

        if (invalidState) {
            throw new Error('WDoubleSync.restore: chain ends in corrupt state with no recovery snapshot; push a full snapshot to repair');
        }

        return dest;
    }

    /**
     * Get the Merkle tree hash for a specific version.
     * Reads backwards from the target to find the nearest full snapshot,
     * then replays only the diff-patches forward.
     * Best case (latest is a full snapshot): single read, no replay.
     *
     * @param {number} [version] - version to query; defaults to latest
     * @returns {Promise<Uint8Array>} 32-byte tree hash
     */
    async getTreeHash(version) {
        await this._ev.initialize();

        const total = this._ev.length;
        const end = (version !== undefined) ? Math.min(version, total) : total;
        if (end === 0) return new Uint8Array(32);

        const diffPatches = [];

        for (let i = end - 1; i >= 0; i--) {
            const item = await this._readPatchDocument(i, total);
            let patchBytes = item.patchBytes;

            if (DoubleSyncFormat.isCompressed(patchBytes)) {
                patchBytes = await DoubleSyncCompressed.decode(patchBytes);
            }

            const kind = DoubleSyncFormat.detect(patchBytes);

            if (kind === 'patch') {
                const parsed = new DoubleSyncPatch(patchBytes);
                if (diffPatches.length === 0) {
                    return new DoubleSyncSnapshot(parsed.snapshot).treeHash;
                }
                let currentSnapshot = parsed.snapshot;
                const store = new CDCStore({ copyBytes: false });
                for (const { hash, bytes } of parsed.chunks()) {
                    store.putWithHash(hash, bytes);
                }
                const dest = new DoubleSyncMemoryFolder('_hash');
                for (const diffBytes of diffPatches) {
                    currentSnapshot = await this._sync.applyDiffPatch({
                        patch: diffBytes, store, dest, prevSnapshot: currentSnapshot,
                    });
                }
                return new DoubleSyncSnapshot(currentSnapshot).treeHash;
            }

            diffPatches.unshift(patchBytes);
        }

        return new Uint8Array(32);
    }

    /**
     * Replay items from the chain into _senderStore and _lastSnapshot so the sender
     * session state is up to date for the next push().
     *
     * @param {number} from - inclusive start index
     * @param {number} to - exclusive end index
     */
    async _replayRange(from, to) {
        const dest = new DoubleSyncMemoryFolder('_replay');
        let invalidState = false;

        for (let i = from; i < to;) {
            const item = await this._readPatchDocument(i, to);
            let patchBytes = item.patchBytes;
            i = item.nextIndex;

            if (DoubleSyncFormat.isCompressed(patchBytes)) {
                patchBytes = await DoubleSyncCompressed.decode(patchBytes);
            }

            const kind = DoubleSyncFormat.detect(patchBytes);

            if (kind === 'patch') {
                // Full snapshot — reset sender state so subsequent diffs build on top of this.
                this._senderStore = new CDCStore({ copyBytes: false });
                this._receiverMirror = new CDCStore();
                await this._sync.applyPatch({ patch: patchBytes, store: this._senderStore, dest });
                const parsed = new DoubleSyncPatch(patchBytes);
                this._lastSnapshot = parsed.snapshot.slice();
                for (const { hash, bytes } of parsed.chunks()) {
                    this._receiverMirror.putWithHash(hash, bytes);
                }
                invalidState = false;
            } else if (kind === 'diff-patch') {
                if (invalidState || !this._lastSnapshot) {
                    continue;
                }
                try {
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
                } catch (_err) {
                    invalidState = true;
                    this._lastSnapshot = null;
                }
            } else {
                throw new Error(`WDoubleSync._replayRange: unknown patch type at index ${i}`);
            }
        }

        if (invalidState) {
            throw new Error('WDoubleSync._replayRange: chain ends in corrupt state with no recovery snapshot');
        }

        this._replayedCount = to;
    }

    async _pushPatchDocument(patchBytes, params) {
        if (!(patchBytes instanceof Uint8Array)) throw new Error('WDoubleSync._pushPatchDocument: patchBytes must be Uint8Array');

        if (!this._maxPatchItemBytes || patchBytes.length <= this._maxPatchItemBytes) {
            await this._ev.push(patchBytes, params);
            return 1;
        }

        const segmentPayloadBytes = Math.max(1, this._maxPatchItemBytes - SEGMENT_HEADER_SIZE);
        const total = Math.ceil(patchBytes.length / segmentPayloadBytes);
        for (let index = 0; index < total; index++) {
            const start = index * segmentPayloadBytes;
            const payload = patchBytes.subarray(start, Math.min(start + segmentPayloadBytes, patchBytes.length));
            await this._ev.push(encodeSegment(payload, { index, total, originalLength: patchBytes.length }), params);
        }
        return total;
    }

    async _readPatchDocument(index, end) {
        const first = await this._ev.at(index);
        const segment = parseSegment(first);
        if (!segment) return { patchBytes: first, nextIndex: index + 1 };

        if (segment.index !== 0) {
            throw new Error(`WDoubleSync: segmented patch at index ${index} starts with segment ${segment.index}`);
        }

        const parts = new Array(segment.total);
        parts[0] = segment.payload;
        let nextIndex = index + 1;
        for (let expected = 1; expected < segment.total; expected++, nextIndex++) {
            if (nextIndex >= end) {
                throw new Error(`WDoubleSync: incomplete segmented patch at index ${index}`);
            }
            const nextSegment = parseSegment(await this._ev.at(nextIndex));
            if (!nextSegment || nextSegment.index !== expected || nextSegment.total !== segment.total || nextSegment.originalLength !== segment.originalLength) {
                throw new Error(`WDoubleSync: invalid segmented patch segment at index ${nextIndex}`);
            }
            parts[expected] = nextSegment.payload;
        }

        const out = new Uint8Array(segment.originalLength);
        let cur = 0;
        for (const part of parts) {
            out.set(part, cur);
            cur += part.length;
        }
        if (cur !== out.length) throw new Error(`WDoubleSync: segmented patch size mismatch (${cur} != ${out.length})`);
        return { patchBytes: out, nextIndex };
    }

    _cloneReceiverMirror() {
        const store = new CDCStore({ copyBytes: false });
        for (const hash of this._receiverMirror.hashes()) {
            const bytes = this._receiverMirror.get(hash);
            if (bytes) store.putWithHash(hash, bytes);
        }
        return store;
    }
}

function encodeSegment(payload, { index, total, originalLength }) {
    const out = new Uint8Array(SEGMENT_HEADER_SIZE + payload.length);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint32(0, SEGMENT_MAGIC, true);
    out[4] = SEGMENT_VERSION;
    dv.setUint32(8, index, true);
    dv.setUint32(12, total, true);
    dv.setBigUint64(16, BigInt(originalLength), true);
    out.set(payload, SEGMENT_HEADER_SIZE);
    return out;
}

function parseSegment(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < SEGMENT_HEADER_SIZE) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== SEGMENT_MAGIC || bytes[4] !== SEGMENT_VERSION) return null;
    const index = dv.getUint32(8, true);
    const total = dv.getUint32(12, true);
    const originalLength = Number(dv.getBigUint64(16, true));
    if (!total || index >= total || !Number.isSafeInteger(originalLength)) {
        throw new Error('WDoubleSync: invalid segmented patch header');
    }
    return {
        index,
        total,
        originalLength,
        payload: bytes.subarray(SEGMENT_HEADER_SIZE),
    };
}
