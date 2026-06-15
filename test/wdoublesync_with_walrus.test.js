/**
 * Integration tests for WDoubleSync with large payloads that trigger
 * EndlessVector's Walrus blob routing (> 120 KB) and history management.
 *
 * Covers 200 KB and 1 MB file trees pushed through WDoubleSync, verifying
 * round-trip correctness when patches themselves are large enough to be
 * stored as Walrus blobs.
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { EndlessVector } from '@fizzyflow/endless-vector';
import {
    DoubleSync,
    DoubleSyncMemoryFolder,
    DoubleSyncFormat,
    DoubleSyncDiffPatch,
} from '@fizzyflow/doublesync';
import WDoubleSync from '../WDoubleSync.js';
import { equalUint8Arrays, randomBytesOfLength, seededBytes, collectTree, treesEqual } from './helpers.js';
import { setupLocalnet, teardownLocalnet } from './fixture.js';

const TX_TIMEOUT = 90_000;

let suiMaster;
let walrusServer;
let walrusClient;
let packageId;

// ─── setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
    ({ suiMaster, walrusServer, walrusClient, packageId } = await setupLocalnet());
    console.log('package id:', packageId);
});

afterAll(async () => {
    await teardownLocalnet();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

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
    return new DoubleSync({ avgSize: 8192 });
}

// ─── 200 KB files ────────────────────────────────────────────────────────────

describe('200 KB files', () => {
    it('pushes a tree with a 200 KB file and restores it byte-equal', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const largeData = randomBytesOfLength(200 * 1024);
        const smallData = seededBytes(512, 1);

        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('large.bin', largeData);
        await sender.addFile('small.txt', smallData);

        await w.initialize();
        await w.push(sender);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const restored = await w2.restore();

        const restoredLarge = await (await restored.findByPath(['large.bin'])).getContent();
        const restoredSmall = await (await restored.findByPath(['small.txt'])).getContent();
        expect(restoredLarge.length).toBe(200 * 1024);
        expect(equalUint8Arrays(restoredLarge, largeData)).toBe(true);
        expect(equalUint8Arrays(restoredSmall, smallData)).toBe(true);
    }, TX_TIMEOUT);

    it('incremental edit on a 200 KB file produces a diff and restores byte-equal', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const sender = new DoubleSyncMemoryFolder('proj');
        const bigData = randomBytesOfLength(200 * 1024);
        const otherData = seededBytes(1024, 2);
        await sender.addFile('big.bin', bigData);
        await sender.addFile('other.txt', otherData);

        await w.initialize();
        await w.push(sender);

        // Small edit in the middle of the large file
        const big = await sender.findByPath(['big.bin']);
        const old = await big.getContent();
        const edited = new Uint8Array(old.length + 64);
        edited.set(old.subarray(0, 100 * 1024));
        edited.set(randomBytesOfLength(64), 100 * 1024);
        edited.set(old.subarray(100 * 1024), 100 * 1024 + 64);
        await big.setContent(edited);

        await w.push(sender);

        await ev.reInitialize();
        await ev.initialize();
        expect(ev.length).toBe(2);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const restored = await w2.restore();

        const restoredBig = await (await restored.findByPath(['big.bin'])).getContent();
        const restoredOther = await (await restored.findByPath(['other.txt'])).getContent();
        expect(restoredBig.length).toBe(edited.length);
        expect(equalUint8Arrays(restoredBig, edited)).toBe(true);
        expect(equalUint8Arrays(restoredOther, otherData)).toBe(true);
    }, TX_TIMEOUT * 2);

    it('multiple 200 KB files across folders restored byte-equal', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const image1Data = randomBytesOfLength(200 * 1024);
        const image2Data = randomBytesOfLength(200 * 1024);
        const dumpData = randomBytesOfLength(200 * 1024);
        const readmeData = seededBytes(2048, 3);

        const sender = new DoubleSyncMemoryFolder('proj');
        const assets = await sender.addFolder('assets');
        await assets.addFile('image1.bin', image1Data);
        await assets.addFile('image2.bin', image2Data);
        const data = await sender.addFolder('data');
        await data.addFile('dump.bin', dumpData);
        await sender.addFile('readme.md', readmeData);

        await w.initialize();
        await w.push(sender);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const restored = await w2.restore();

        const ri1 = await (await restored.findByPath(['assets', 'image1.bin'])).getContent();
        const ri2 = await (await restored.findByPath(['assets', 'image2.bin'])).getContent();
        const rd = await (await restored.findByPath(['data', 'dump.bin'])).getContent();
        const rr = await (await restored.findByPath(['readme.md'])).getContent();

        expect(ri1.length).toBe(200 * 1024);
        expect(ri2.length).toBe(200 * 1024);
        expect(rd.length).toBe(200 * 1024);
        expect(equalUint8Arrays(ri1, image1Data)).toBe(true);
        expect(equalUint8Arrays(ri2, image2Data)).toBe(true);
        expect(equalUint8Arrays(rd, dumpData)).toBe(true);
        expect(equalUint8Arrays(rr, readmeData)).toBe(true);
    }, TX_TIMEOUT * 2);
});

// ─── 1 MB files ──────────────────────────────────────────────────────────────

describe('1 MB files', () => {
    it('pushes a tree with a 1 MB file and restores it byte-equal', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const hugeData = randomBytesOfLength(1024 * 1024);
        const configData = seededBytes(256, 10);

        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('huge.bin', hugeData);
        await sender.addFile('config.txt', configData);

        await w.initialize();
        await w.push(sender);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const restored = await w2.restore();

        const restoredHuge = await (await restored.findByPath(['huge.bin'])).getContent();
        const restoredConfig = await (await restored.findByPath(['config.txt'])).getContent();
        expect(restoredHuge.length).toBe(1024 * 1024);
        expect(equalUint8Arrays(restoredHuge, hugeData)).toBe(true);
        expect(equalUint8Arrays(restoredConfig, configData)).toBe(true);
    }, TX_TIMEOUT * 2);

    it('incremental edit on a 1 MB file: diff is small and bytes match', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const hugeData = randomBytesOfLength(1024 * 1024);
        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('huge.bin', hugeData);

        await w.initialize();
        await w.push(sender);

        // Append 1 KB to the end
        const huge = await sender.findByPath(['huge.bin']);
        const old = await huge.getContent();
        const appendChunk = randomBytesOfLength(1024);
        const appended = new Uint8Array(old.length + 1024);
        appended.set(old);
        appended.set(appendChunk, old.length);
        await huge.setContent(appended);

        await w.push(sender);

        await ev.reInitialize();
        await ev.initialize();
        expect(ev.length).toBe(2);

        // Diff patch should be much smaller than the full patch
        const fullSize = (await ev.at(0)).length;
        const diffSize = (await ev.at(1)).length;
        console.log(`1 MB file: full patch ${fullSize} bytes, diff patch ${diffSize} bytes`);
        expect(diffSize).toBeLessThan(fullSize / 2);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const restored = await w2.restore();

        const restoredHuge = await (await restored.findByPath(['huge.bin'])).getContent();
        expect(restoredHuge.length).toBe(appended.length);
        expect(equalUint8Arrays(restoredHuge, appended)).toBe(true);

        // Verify the original portion is intact
        expect(equalUint8Arrays(restoredHuge.subarray(0, 1024 * 1024), hugeData)).toBe(true);
        // Verify the appended portion matches
        expect(equalUint8Arrays(restoredHuge.subarray(1024 * 1024), appendChunk)).toBe(true);
    }, TX_TIMEOUT * 3);
});

// ─── mixed large + small with multiple versions ──────────────────────────────

describe('mixed large and small files across versions', () => {
    it('3-version chain with 200 KB and 1 MB files, partial restore with byte checks', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const readmeV1 = seededBytes(2048, 20);
        const indexData = seededBytes(4096, 21);
        const logoData = randomBytesOfLength(200 * 1024);
        const bigData = randomBytesOfLength(1024 * 1024);
        const readmeV3 = seededBytes(3072, 22);

        const sender = new DoubleSyncMemoryFolder('proj');
        await w.initialize();

        // v1: small files only
        await sender.addFile('readme.md', readmeV1);
        const src = await sender.addFolder('src');
        await src.addFile('index.js', indexData);
        await w.push(sender);

        // v2: add a 200 KB asset
        const assets = await sender.addFolder('assets');
        await assets.addFile('logo.bin', logoData);
        await w.push(sender);

        // v3: add a 1 MB data file + edit a small file
        await sender.addFile('data.bin', bigData);
        const readme = await sender.findByPath(['readme.md']);
        await readme.setContent(readmeV3);
        await w.push(sender);

        await ev.reInitialize();
        await ev.initialize();
        expect(ev.length).toBe(3);

        // Restore latest — verify every file byte-equal
        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const latest = await w2.restore();

        const lReadme = await (await latest.findByPath(['readme.md'])).getContent();
        const lIndex = await (await latest.findByPath(['src', 'index.js'])).getContent();
        const lLogo = await (await latest.findByPath(['assets', 'logo.bin'])).getContent();
        const lData = await (await latest.findByPath(['data.bin'])).getContent();

        expect(equalUint8Arrays(lReadme, readmeV3)).toBe(true);
        expect(equalUint8Arrays(lIndex, indexData)).toBe(true);
        expect(lLogo.length).toBe(200 * 1024);
        expect(equalUint8Arrays(lLogo, logoData)).toBe(true);
        expect(lData.length).toBe(1024 * 1024);
        expect(equalUint8Arrays(lData, bigData)).toBe(true);

        // Restore v1 — should have original readme + index, no large files
        const v1 = await w2.restore(1);
        const v1readme = await (await v1.findByPath(['readme.md'])).getContent();
        const v1index = await (await v1.findByPath(['src', 'index.js'])).getContent();
        expect(equalUint8Arrays(v1readme, readmeV1)).toBe(true);
        expect(equalUint8Arrays(v1index, indexData)).toBe(true);
        expect(await v1.findByPath(['assets', 'logo.bin'])).toBeNull();
        expect(await v1.findByPath(['data.bin'])).toBeNull();

        // Restore v2 — should have 200 KB logo but not 1 MB data
        const v2 = await w2.restore(2);
        const v2logo = await (await v2.findByPath(['assets', 'logo.bin'])).getContent();
        expect(v2logo.length).toBe(200 * 1024);
        expect(equalUint8Arrays(v2logo, logoData)).toBe(true);
        expect(await v2.findByPath(['data.bin'])).toBeNull();
        // v2 still has original readme
        const v2readme = await (await v2.findByPath(['readme.md'])).getContent();
        expect(equalUint8Arrays(v2readme, readmeV1)).toBe(true);
    }, TX_TIMEOUT * 4);
});

// ─── compressed large payloads ───────────────────────────────────────────────

describe('compressed large payloads', () => {
    it('gzip-compressed 200 KB tree round-trips byte-equal', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync, compress: 'gzip' });

        const largeData = randomBytesOfLength(200 * 1024);
        const smallData = seededBytes(512, 30);

        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('large.bin', largeData);
        await sender.addFile('small.txt', smallData);

        await w.initialize();
        await w.push(sender);

        const raw = await ev.at(0);
        expect(DoubleSyncFormat.detect(raw)).toBe('compressed');

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const restored = await w2.restore();

        const restoredLarge = await (await restored.findByPath(['large.bin'])).getContent();
        const restoredSmall = await (await restored.findByPath(['small.txt'])).getContent();
        expect(restoredLarge.length).toBe(200 * 1024);
        expect(equalUint8Arrays(restoredLarge, largeData)).toBe(true);
        expect(equalUint8Arrays(restoredSmall, smallData)).toBe(true);
    }, TX_TIMEOUT * 2);
});
