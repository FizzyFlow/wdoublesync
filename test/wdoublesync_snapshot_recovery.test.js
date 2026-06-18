/**
 * Tests for full-snapshot recovery in WDoubleSync.
 *
 * Background: a bug in the watch command caused a diff patch to be pushed with
 * a stale base snapshot (the client's ev.length was updated by a poll but
 * wdsync._lastSnapshot was not). The resulting diff on-chain references the
 * wrong prevSnapshot, so restore() / _replayRange() throw when they try to
 * apply it.
 *
 * Fix: restore() and _replayRange() now treat a full snapshot (DoubleSyncPatch)
 * at any chain position as a recovery point — resetting all state and skipping
 * any corrupt diffs that preceded it.
 *
 * These tests verify that behaviour end-to-end.
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { EndlessVector } from '@fizzyflow/endless-vector';
import { DoubleSync, DoubleSyncMemoryFolder } from '@fizzyflow/doublesync';
import WDoubleSync from '../WDoubleSync.js';
import { seededBytes, equalUint8Arrays, treesEqual } from './helpers.js';
import { setupLocalnet, teardownLocalnet } from './fixture.js';

const TX_TIMEOUT = 60_000;

let suiMaster;
let walrusServer;
let walrusClient;
let packageId;

// ─── setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
    ({ suiMaster, walrusServer, walrusClient, packageId } = await setupLocalnet());
});

afterAll(async () => {
    await teardownLocalnet();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSignAndExecute() {
    return async (tx) => {
        const result = await suiMaster.signAndExecuteTransaction({ transaction: tx });
        return result.digest;
    };
}

async function createEV() {
    return EndlessVector.create({
        suiClient: suiMaster.client,
        packageId,
        walrusClient,
        aggregatorUrl: walrusServer?.url,
        senderAddress: suiMaster.address,
        signAndExecuteTransaction: makeSignAndExecute(),
    });
}

function makeEV(id) {
    return new EndlessVector({
        suiClient: suiMaster.client,
        id,
        packageId,
        walrusClient,
        aggregatorUrl: walrusServer?.url,
        senderAddress: suiMaster.address,
        signAndExecuteTransaction: makeSignAndExecute(),
    });
}

function makeWDoubleSync(ev) {
    return new WDoubleSync({ endlessVector: ev, sync: new DoubleSync({ avgSize: 4096 }) });
}

/**
 * Push a full snapshot at the current chain position, bypassing chain replay.
 * Mirrors the CLI --force-snapshot behaviour used to repair corrupt vectors.
 */
async function forceFullSnapshot(wdsync, ev, folder) {
    await ev.initialize();
    wdsync._isInitialized = true;
    wdsync._lastSnapshot = null;
    wdsync._replayedCount = ev.length;
    return wdsync.push(folder);
}

/**
 * Build a minimal corrupt chain that reproduces the watch-command bug.
 *
 * Chain layout after this returns:
 *   index 0: full snapshot  (folder_v1 — "a.txt" seed 1)
 *   index 1: valid diff      (folder_v2 — "a.txt" seed 2)
 *   index 2: corrupt diff    (diff built against v1 snapshot, positioned at index 2
 *                             — applyDiffPatch fails because prevSnapshot ≠ v2 snapshot)
 *
 * Returns { ev, wdsync, folder_v1, folder_v2, folder_v3 } so callers can build on top.
 */
async function buildCorruptChain() {
    const ev = await createEV();
    const wdsync = makeWDoubleSync(ev);

    // v0: full snapshot pushed by wdsync
    const folder_v1 = new DoubleSyncMemoryFolder('root');
    await folder_v1.addFile('a.txt', seededBytes(2048, 1));
    await wdsync.initialize();
    await wdsync.push(folder_v1);
    // wdsync._replayedCount = 1, _lastSnapshot = snap_v1

    // v1: valid diff pushed by a separate wdsync instance (simulates another client)
    const ev2 = makeEV(ev.id);
    const wdsync2 = makeWDoubleSync(ev2);
    const folder_v2 = new DoubleSyncMemoryFolder('root');
    await folder_v2.addFile('a.txt', seededBytes(2048, 2));
    await wdsync2.initialize();
    await wdsync2.push(folder_v2);
    // chain length is now 2; wdsync doesn't know yet

    // Simulate the watch bug: ev.length gets updated (by a poll) but wdsync state stays stale
    ev.reInitialize();
    await ev.initialize();
    // ev.length = 2, but wdsync._lastSnapshot is still snap_v1

    // v2: corrupt diff — wdsync builds against snap_v1 but ensure_length lands it at index 2
    const folder_v3 = new DoubleSyncMemoryFolder('root');
    await folder_v3.addFile('a.txt', seededBytes(2048, 3));
    await wdsync.push(folder_v3);
    // restore() will now fail: diff at index 2 expects prevSnapshot=snap_v1,
    // but restore() hands it prevSnapshot=snap_v2

    return { ev, wdsync, folder_v1, folder_v2, folder_v3 };
}

// ─── 1. restore() on corrupt chain ───────────────────────────────────────────

describe('restore() on corrupt chain', () => {
    it('throws when chain ends in corrupt state with no recovery snapshot', async () => {
        const { ev } = await buildCorruptChain();
        const reader = makeWDoubleSync(makeEV(ev.id));
        await expect(reader.restore()).rejects.toThrow('corrupt state');
    }, TX_TIMEOUT * 3);

    it('restore(n) to the last good version still succeeds', async () => {
        const { ev, folder_v2 } = await buildCorruptChain();
        const reader = makeWDoubleSync(makeEV(ev.id));

        // version 2 = first two items (full + valid diff) — before the corrupt one
        const restored = await reader.restore(2);
        expect(await treesEqual(restored, folder_v2)).toBe(true);
    }, TX_TIMEOUT * 3);
});

// ─── 2. force-snapshot repair ────────────────────────────────────────────────

describe('force-snapshot repair', () => {
    it('restore() skips corrupt diff and recovers at the new full snapshot', async () => {
        const { ev, wdsync } = await buildCorruptChain();

        // Repair: push a full snapshot at the current chain tip
        const folder_v4 = new DoubleSyncMemoryFolder('root');
        await folder_v4.addFile('a.txt', seededBytes(2048, 4));
        await folder_v4.addFile('b.txt', seededBytes(512, 40));
        await forceFullSnapshot(wdsync, ev, folder_v4);

        // restore() must skip index 2 (corrupt diff) and recover from index 3 (full)
        const reader = makeWDoubleSync(makeEV(ev.id));
        const restored = await reader.restore();
        expect(await treesEqual(restored, folder_v4)).toBe(true);
    }, TX_TIMEOUT * 3);

    it('file content from recovery snapshot is byte-equal to what was pushed', async () => {
        const { ev, wdsync } = await buildCorruptChain();

        const expected = seededBytes(4096, 99);
        const folder_v4 = new DoubleSyncMemoryFolder('root');
        await folder_v4.addFile('recovery.bin', expected);
        await forceFullSnapshot(wdsync, ev, folder_v4);

        const reader = makeWDoubleSync(makeEV(ev.id));
        const restored = await reader.restore();
        const file = await restored.findByPath(['recovery.bin']);
        expect(file).not.toBeNull();
        const content = await file.getContent();
        expect(equalUint8Arrays(content, expected)).toBe(true);
    }, TX_TIMEOUT * 3);
});

// ─── 3. push after repair ────────────────────────────────────────────────────

describe('push after repair', () => {
    it('diff pushed on same wdsync instance after force-snapshot is applied correctly', async () => {
        const { ev, wdsync } = await buildCorruptChain();

        const folder_v4 = new DoubleSyncMemoryFolder('root');
        await folder_v4.addFile('a.txt', seededBytes(2048, 4));
        await forceFullSnapshot(wdsync, ev, folder_v4);
        // wdsync._lastSnapshot is now snap_v4

        // Edit and push another diff via the same instance
        const folder_v5 = new DoubleSyncMemoryFolder('root');
        await folder_v5.addFile('a.txt', seededBytes(2048, 5));
        await folder_v5.addFile('new.txt', seededBytes(256, 50));
        await wdsync.push(folder_v5);

        const reader = makeWDoubleSync(makeEV(ev.id));
        const restored = await reader.restore();
        expect(await treesEqual(restored, folder_v5)).toBe(true);
    }, TX_TIMEOUT * 3);

    it('fresh wdsync initializes through corrupt history and pushes a correct diff', async () => {
        // This specifically tests _replayRange() recovery: a brand-new WDoubleSync
        // instance calls initialize() which replays the whole chain including the
        // corrupt diff, must survive it by resetting at the subsequent full snapshot.
        const { ev, wdsync } = await buildCorruptChain();

        const folder_v4 = new DoubleSyncMemoryFolder('root');
        await folder_v4.addFile('a.txt', seededBytes(2048, 4));
        await forceFullSnapshot(wdsync, ev, folder_v4);

        // Fresh instance — initialize() triggers _replayRange(0, 4)
        const ev3 = makeEV(ev.id);
        const wdsync3 = makeWDoubleSync(ev3);
        await wdsync3.initialize();   // must not throw despite corrupt index 2
        expect(wdsync3._lastSnapshot).not.toBeNull();

        const folder_v5 = new DoubleSyncMemoryFolder('root');
        await folder_v5.addFile('a.txt', seededBytes(2048, 5));
        await wdsync3.push(folder_v5);

        const reader = makeWDoubleSync(makeEV(ev.id));
        const restored = await reader.restore();
        expect(await treesEqual(restored, folder_v5)).toBe(true);
    }, TX_TIMEOUT * 3);
});

// ─── 4. no regression on clean chains ────────────────────────────────────────

describe('no regression on clean chains', () => {
    it('full snapshot mid-chain (no corruption) is treated as a new baseline', async () => {
        // Push v1 normally, then push v2 as an intentional mid-chain full snapshot,
        // then push v3 as a diff on top of v2.  restore() should return v3 state.
        const ev = await createEV();
        const wdsync = makeWDoubleSync(ev);

        const folder_v1 = new DoubleSyncMemoryFolder('root');
        await folder_v1.addFile('x.txt', seededBytes(1024, 10));
        await wdsync.initialize();
        await wdsync.push(folder_v1);

        // Intentional mid-chain full snapshot (e.g. after a long divergence)
        const folder_v2 = new DoubleSyncMemoryFolder('root');
        await folder_v2.addFile('y.txt', seededBytes(1024, 20));
        await forceFullSnapshot(wdsync, ev, folder_v2);

        // Diff on top of v2
        const folder_v3 = new DoubleSyncMemoryFolder('root');
        await folder_v3.addFile('y.txt', seededBytes(1024, 21));
        await folder_v3.addFile('z.txt', seededBytes(512, 30));
        await wdsync.push(folder_v3);

        const reader = makeWDoubleSync(makeEV(ev.id));
        const restored = await reader.restore();
        expect(await treesEqual(restored, folder_v3)).toBe(true);
    }, TX_TIMEOUT * 3);

    it('sequential normal pushes are unaffected', async () => {
        const ev = await createEV();
        const wdsync = makeWDoubleSync(ev);
        await wdsync.initialize();

        const folders = [];
        for (let i = 0; i < 3; i++) {
            const f = new DoubleSyncMemoryFolder('root');
            await f.addFile('doc.txt', seededBytes(1024, i + 100));
            folders.push(f);
            await wdsync.push(f);
        }

        const reader = makeWDoubleSync(makeEV(ev.id));
        const restored = await reader.restore();
        expect(await treesEqual(restored, folders[2])).toBe(true);
    }, TX_TIMEOUT * 3);
});
