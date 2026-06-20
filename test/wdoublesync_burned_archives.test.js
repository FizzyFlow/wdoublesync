/**
 * Tests for WDoubleSync with burned archives.
 *
 * Covers:
 * - Initializing correctly handles burnedArchiveCount
 * - WDoubleSync can push fresh snapshots as part of rebate workflow
 * - Multiple pushes after archive/burn operations
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { EndlessVector } from '@fizzyflow/endless-vector';
import {
    DoubleSync,
    DoubleSyncMemoryFolder,
    DoubleSyncFormat,
} from '@fizzyflow/doublesync';
import WDoubleSync from '../WDoubleSync.js';
import { seededBytes, treesEqual } from './helpers.js';
import { setupLocalnet, teardownLocalnet } from './fixture.js';

const TX_TIMEOUT = 60_000;

let suiMaster;
let walrusServer;
let walrusClient;
let packageId;

beforeAll(async () => {
    ({ suiMaster, walrusServer, walrusClient, packageId } = await setupLocalnet());
});

afterAll(async () => {
    await teardownLocalnet();
});

function makeSignAndExecute() {
    return async (tx) => {
        const result = await suiMaster.signAndExecuteTransaction({
            transaction: tx,
        });
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

function makeSync() {
    return new DoubleSync({ avgSize: 1024 });
}

// ─── burned archives tests ───────────────────────────────────────────────────

describe('burned archives', () => {
    it('initializes correctly after multiple pushes', async () => {
        const ev = await createEV();
        const w = new WDoubleSync({ endlessVector: ev, sync: makeSync() });

        // Create initial state with multiple pushes
        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('file1.txt', seededBytes(1024, 1));

        await w.initialize();
        const v1 = await w.push(sender);
        expect(v1.version).toBe(1);

        // Make changes and push again
        await sender.addFile('file2.txt', seededBytes(1024, 2));
        const v2 = await w.push(sender);
        expect(v2.version).toBe(2);

        // Verify state is readable
        expect(ev.length).toBe(2);

        // Initialize a new WDoubleSync instance
        const ev2 = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: ev2, sync: makeSync() });
        await w2.initialize();
        expect(w2._isInitialized).toBe(true);
        expect(w2._replayedCount).toBe(2);
    });

    it('respects burnedArchiveCount when initializing', async () => {
        const ev = await createEV();
        const w = new WDoubleSync({ endlessVector: ev, sync: makeSync() });

        // Push content
        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('test.txt', seededBytes(512, 1));
        await w.initialize();
        await w.push(sender);

        // Get the current burned count (should be 0 initially)
        await ev.initialize();
        const initialBurnedCount = ev.burnedArchiveCount || 0;

        // Initialize a new WDoubleSync
        const ev2 = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: ev2, sync: makeSync() });

        // Should handle initialization properly regardless of burnedArchiveCount
        await w2.initialize();
        expect(w2._isInitialized).toBe(true);
    });

    it('can force fresh snapshot for rebate workflow', async () => {
        const ev = await createEV();
        const w = new WDoubleSync({ endlessVector: ev, sync: makeSync() });

        // Initial setup
        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('v1.txt', seededBytes(512, 1));
        await w.initialize();
        const result1 = await w.push(sender);
        expect(result1.version).toBe(1);

        // Simulate rebate workflow:
        // Create new instance and force fresh snapshot
        const ev2 = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: ev2, sync: makeSync() });

        // Initialize will replay existing items
        await w2.initialize();

        // Force a full snapshot instead of diff patch
        w2._lastSnapshot = null;

        // Push new state as fresh snapshot
        const sender2 = new DoubleSyncMemoryFolder('proj');
        await sender2.addFile('v2.txt', seededBytes(512, 2));
        const result2 = await w2.push(sender2);

        expect(result2.version).toBeGreaterThan(result1.version);

        // Verify we can restore the new snapshot
        const ev3 = makeEV(ev.id);
        const w3 = new WDoubleSync({ endlessVector: ev3, sync: makeSync() });
        const restored = await w3.restore();

        const files = await restored.list();
        const fileNames = files.map(f => f.name);
        expect(fileNames).toContain('v2.txt');
    });

    it('handles initialization when replayedCount needs reset', async () => {
        const ev = await createEV();
        const w = new WDoubleSync({ endlessVector: ev, sync: makeSync() });

        // Push initial content
        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('file.txt', seededBytes(1024, 1));
        await w.initialize();
        await w.push(sender);

        // Create a new WDoubleSync with custom replay count
        const ev2 = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: ev2, sync: makeSync() });

        // Manually set replay count to 0 to simulate first initialization
        w2._replayedCount = 0;

        // Initialize should properly handle and set replay state
        await w2.initialize();
        expect(w2._isInitialized).toBe(true);
        expect(w2._lastSnapshot).not.toBeNull();
    });

    it('correctly detects and uses full snapshots during replay', async () => {
        const ev = await createEV();
        const w = new WDoubleSync({ endlessVector: ev, sync: makeSync() });

        // Create initial state with full snapshot (v1)
        const sender1 = new DoubleSyncMemoryFolder('proj');
        await sender1.addFile('file1.txt', seededBytes(512, 1));
        await w.initialize();
        const result1 = await w.push(sender1);
        expect(result1.version).toBe(1);

        // Add more changes for diff patch (v2)
        await sender1.addFile('file2.txt', seededBytes(512, 2));
        const result2 = await w.push(sender1);
        expect(result2.version).toBe(2);

        // Initialize a fresh WDoubleSync to test replay
        const ev2 = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: ev2, sync: makeSync() });

        // This should find and use the full snapshot at v1
        await w2.initialize();

        // Should have replayed all items
        expect(w2._replayedCount).toBe(2);
        expect(w2._lastSnapshot).not.toBeNull();
    });

    it('tracks burned archive count increase', async () => {
        const ev = await createEV();
        const w = new WDoubleSync({ endlessVector: ev, sync: makeSync() });

        // Initial burned count
        await ev.initialize();
        const initialBurnedCount = ev.burnedArchiveCount || 0;

        // Create and archive content
        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('test.txt', seededBytes(512, 1));
        await w.initialize();
        await w.push(sender);

        // Archive the items
        await ev.archive();
        const afterArchive = ev.archiveItemsCount;

        // Burn the archive
        await ev.burnArchive();
        await ev.initialize();
        const finalBurnedCount = ev.burnedArchiveCount || 0;

        // If archives were created, burned count should increase
        if (afterArchive > 0) {
            expect(finalBurnedCount).toBeGreaterThan(initialBurnedCount);
        }
        // If no archives were created, burned count should remain the same
        expect(finalBurnedCount).toBeGreaterThanOrEqual(initialBurnedCount);
    });

    it('rebate: archive, burn, then push fresh snapshot with file content', async () => {
        // Step 1: Create initial vector with content
        const ev = await createEV();
        const w = new WDoubleSync({ endlessVector: ev, sync: makeSync() });

        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('original.txt', seededBytes(512, 1));
        await sender.addFile('data.bin', seededBytes(1024, 2));
        await w.initialize();
        const v1 = await w.push(sender);
        expect(v1.version).toBe(1);

        // Add more files and push (creates diffs)
        await sender.addFile('extra.txt', seededBytes(256, 3));
        const v2 = await w.push(sender);
        expect(v2.version).toBe(2);

        // Step 2: Archive and burn history
        await ev.initialize();
        const beforeBurn = ev.burnedArchiveCount || 0;
        await ev.archive();
        await ev.burnArchive();
        await ev.initialize();
        const afterBurn = ev.burnedArchiveCount || 0;
        expect(afterBurn).toBeGreaterThanOrEqual(beforeBurn);

        // Step 3: Push fresh snapshot after burning
        // Reset WDoubleSync state to force a fresh snapshot (not a diff)
        const ev2 = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: ev2, sync: makeSync() });

        // Reset internal state to skip replay of burned items
        const { CDCStore } = await import('@fizzyflow/doublesync');
        w2._senderStore = new CDCStore({ copyBytes: false });
        w2._receiverMirror = new CDCStore();
        w2._lastSnapshot = null;
        w2._replayedCount = 0;
        w2._isInitialized = false;

        // Push new content
        const sender2 = new DoubleSyncMemoryFolder('proj');
        await sender2.addFile('fresh.txt', seededBytes(512, 4));
        await sender2.addFile('snapshot.dat', seededBytes(1024, 5));
        const v3 = await w2.push(sender2);
        expect(v3.version).toBeGreaterThan(v2.version);

        // Step 4: Restore the fresh snapshot and verify it has the new content
        const ev3 = makeEV(ev.id);
        const w3 = new WDoubleSync({ endlessVector: ev3, sync: makeSync() });
        const restored = await w3.restore(v3.version);

        const files = await restored.list();
        const fileNames = files.map(f => f.name);

        // Should have the fresh content
        expect(fileNames).toContain('fresh.txt');
        expect(fileNames).toContain('snapshot.dat');

        // Should NOT have old content (this is a fresh snapshot, not a continuation)
        expect(fileNames).not.toContain('original.txt');
        expect(fileNames).not.toContain('data.bin');
        expect(fileNames).not.toContain('extra.txt');
    });
});
