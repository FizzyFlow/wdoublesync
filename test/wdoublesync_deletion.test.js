import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { EndlessVector } from '@fizzyflow/endless-vector';
import {
    DoubleSync,
    DoubleSyncMemoryFolder,
} from '@fizzyflow/doublesync';
import WDoubleSync from '../WDoubleSync.js';
import { equalUint8Arrays, seededBytes, collectTree } from './helpers.js';
import { setupLocalnet, teardownLocalnet } from './fixture.js';

const TX_TIMEOUT = 90_000;

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

function makeSync() {
    return new DoubleSync({ avgSize: 1024 });
}

describe('file deletion', () => {
    it('deleted file is absent after restore', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('a.txt', seededBytes(2048, 1));
        await sender.addFile('b.txt', seededBytes(2048, 2));
        await sender.addFile('c.txt', seededBytes(2048, 3));

        await w.initialize();
        await w.push(sender);

        await sender.removeChild('b.txt');
        await w.push(sender);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const restored = await w2.restore();

        const tree = await collectTree(restored);
        const paths = tree.map(t => t.path.join('/'));
        expect(paths).toEqual(['a.txt', 'c.txt']);
        expect(await restored.findByPath(['b.txt'])).toBeNull();

        expect(equalUint8Arrays(tree[0].bytes, seededBytes(2048, 1))).toBe(true);
        expect(equalUint8Arrays(tree[1].bytes, seededBytes(2048, 3))).toBe(true);
    }, TX_TIMEOUT);

    it('delete all files then re-add produces correct tree', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('old.txt', seededBytes(1024, 10));

        await w.initialize();
        await w.push(sender);

        await sender.removeChild('old.txt');
        await sender.addFile('new.txt', seededBytes(1024, 11));
        await w.push(sender);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const restored = await w2.restore();

        const tree = await collectTree(restored);
        expect(tree.map(t => t.path.join('/'))).toEqual(['new.txt']);
        expect(equalUint8Arrays(tree[0].bytes, seededBytes(1024, 11))).toBe(true);
        expect(await restored.findByPath(['old.txt'])).toBeNull();
    }, TX_TIMEOUT);
});

describe('folder deletion', () => {
    it('deleted subfolder and its files are absent after restore', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('root.txt', seededBytes(1024, 20));
        const sub = await sender.addFolder('sub');
        await sub.addFile('deep.txt', seededBytes(1024, 21));
        await sub.addFile('other.txt', seededBytes(1024, 22));

        await w.initialize();
        await w.push(sender);

        await sender.removeChild('sub');
        await w.push(sender);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const restored = await w2.restore();

        const tree = await collectTree(restored);
        expect(tree.map(t => t.path.join('/'))).toEqual(['root.txt']);
        expect(await restored.findByPath(['sub'])).toBeNull();
        expect(await restored.findByPath(['sub', 'deep.txt'])).toBeNull();
    }, TX_TIMEOUT);

    it('delete folder then re-add folder with different contents', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const sender = new DoubleSyncMemoryFolder('proj');
        const sub = await sender.addFolder('data');
        await sub.addFile('v1.bin', seededBytes(2048, 30));

        await w.initialize();
        await w.push(sender);

        await sender.removeChild('data');
        const sub2 = await sender.addFolder('data');
        await sub2.addFile('v2.bin', seededBytes(2048, 31));
        await w.push(sender);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });
        const restored = await w2.restore();

        const tree = await collectTree(restored);
        expect(tree.map(t => t.path.join('/'))).toEqual(['data/v2.bin']);
        expect(await restored.findByPath(['data', 'v1.bin'])).toBeNull();
        expect(equalUint8Arrays(tree[0].bytes, seededBytes(2048, 31))).toBe(true);
    }, TX_TIMEOUT);
});

describe('version restore with deletions', () => {
    it('restoring earlier version still has the deleted file', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('keep.txt', seededBytes(1024, 40));
        await sender.addFile('gone.txt', seededBytes(1024, 41));

        await w.initialize();
        await w.push(sender);

        await sender.removeChild('gone.txt');
        await w.push(sender);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });

        const v1 = await w2.restore(1);
        const v1tree = await collectTree(v1);
        expect(v1tree.map(t => t.path.join('/'))).toEqual(['gone.txt', 'keep.txt']);
        expect(equalUint8Arrays(
            (await (await v1.findByPath(['gone.txt'])).getContent()),
            seededBytes(1024, 41),
        )).toBe(true);

        const latest = await w2.restore();
        const latestTree = await collectTree(latest);
        expect(latestTree.map(t => t.path.join('/'))).toEqual(['keep.txt']);
        expect(await latest.findByPath(['gone.txt'])).toBeNull();
    }, TX_TIMEOUT);

    it('three versions: add, delete, re-add with different content', async () => {
        const ev = await createEV();
        const sync = makeSync();
        const w = new WDoubleSync({ endlessVector: ev, sync });

        const sender = new DoubleSyncMemoryFolder('proj');
        await sender.addFile('file.txt', seededBytes(2048, 50));

        await w.initialize();

        // v1: file exists
        await w.push(sender);

        // v2: file deleted
        await sender.removeChild('file.txt');
        await w.push(sender);

        // v3: file re-added with new content
        await sender.addFile('file.txt', seededBytes(2048, 51));
        await w.push(sender);

        const evReader = makeEV(ev.id);
        const w2 = new WDoubleSync({ endlessVector: evReader, sync: makeSync() });

        const v1 = await w2.restore(1);
        expect(equalUint8Arrays(
            (await (await v1.findByPath(['file.txt'])).getContent()),
            seededBytes(2048, 50),
        )).toBe(true);

        const v2 = await w2.restore(2);
        expect(await v2.findByPath(['file.txt'])).toBeNull();

        const v3 = await w2.restore(3);
        expect(equalUint8Arrays(
            (await (await v3.findByPath(['file.txt'])).getContent()),
            seededBytes(2048, 51),
        )).toBe(true);
    }, TX_TIMEOUT * 2);
});
