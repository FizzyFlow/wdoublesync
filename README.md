# WDoubleSync

Folder-tree delta sync on the Sui blockchain.

WDoubleSync combines the power of two. Two libraries walk into a blockchain...

- **EndlessVector** is a scalable append-only `vector<vector<u8>>` on Sui that grows beyond object size limits by automatically splitting data into history segments and offloading large items as Walrus blobs. It has built-in Seal encryption support — all stored data can be AES encrypted with Seal-wrapped keys, so only the vector owner can decrypt. This is advised for any production data.
- **DoubleSync** is a content-defined chunking engine that splits files at content-determined boundaries so that small edits only affect nearby chunks, deduplicates identical chunks by SHA-256, fingerprints folder trees as Merkle trees for fast skip of unchanged subtrees, and produces compact incremental diff patches that carry only the changed operations and chunks. 

Together: DoubleSync builds snapshot and diff patch documents from a folder tree, and EndlessVector stores them as an ordered chain of items on Sui, giving you versioned, deduplicated, incrementally-updated folder sync on the blockchain. Both libraries work and are tested in Node.js and in the browser, and have abstract filesystem interfaces that can be backed by anything — real disk, in-memory, or any custom state layer.

**TL;DR:** git-like filesystem/folder versioning on Sui(+Walrus+Seal).

Both libraries are fully standalone and can be used independently of each other and without WDoubleSync. EndlessVector works as general-purpose scalable on-chain storage for any `vector<u8>` data, and DoubleSync works as a pure CDC diff engine for any folder sync scenario — network, disk, database, cloud, any abstraction and whatever transport you want.

## Overview

WDoubleSync stores a chain of patch documents inside an EndlessVector on Sui:

```
EndlessVector (on-chain)
  item[0]  full DoubleSyncPatch        (initial state)
  item[1]  DoubleSyncDiffPatch         (v1 -> v2, only changed chunks)
  item[2]  DoubleSyncDiffPatch         (v2 -> v3)
  ...
```

The first push is always a self-contained full patch. Every subsequent push produces an incremental diff patch that carries only the operations and chunks the receiver doesn't already have. Patch type is auto-detected by magic header — no metadata needed.

EndlessVector handles all on-chain size constraints automatically (history/archive tiers, Walrus blob offloading for large payloads).

## Features

- **Incremental sync**: Content-defined chunking means only changed bytes cross the wire and land on-chain
- **Version history**: Every push is a new version; restore any past version by replaying the chain
- **Auto-detection**: Patch type (full / diff / compressed) detected from magic bytes
- **Compression**: Optional gzip envelope to reduce on-chain storage cost
- **Stateless resume**: A new sender instance rebuilds its CDC store and session state by replaying existing chain items — no local state required between sessions
- **Transparent blob routing**: Large patches are automatically stored as Walrus blobs by EndlessVector

## Install

```bash
pnpm add wdoublesync
```

## Usage

### Sender: push folder state to chain

```js
import EndlessVector from '@fizzyflow/endless-vector';
import { DoubleSync, DoubleSyncMemoryFolder } from '@fizzyflow/doublesync';
import WDoubleSync from '@fizzyflow/wdoublesync';

const ev = new EndlessVector({
    suiClient,
    id: '0x...',
    packageId,
    signAndExecuteTransaction,
    walrusClient,          // optional, for large patches
});

const sync = new DoubleSync({ avgSize: 8192 });
const w = new WDoubleSync({ endlessVector: ev, sync });
await w.initialize();

// Build your folder tree
const root = new DoubleSyncMemoryFolder('project');
const src = await root.addFolder('src');
await src.addFile('index.js', new TextEncoder().encode('console.log("hello")'));
await root.addFile('README.md', new TextEncoder().encode('# My Project'));

// Push to chain (first call = full patch, subsequent = diff)
await w.push(root);

// Edit and push again — only the diff goes on-chain
await src.addFile('utils.js', new TextEncoder().encode('export function add(a, b) { return a + b; }'));
await w.push(root);
```

### Receiver: restore folder state from chain

```js
const ev = new EndlessVector({ suiClient, id: '0x...' });
const w = new WDoubleSync({ endlessVector: ev });

// Restore latest version
const folder = await w.restore();

// Or restore a specific version
const v1 = await w.restore(1);
```

### Compression

```js
const w = new WDoubleSync({ endlessVector: ev, sync, compress: 'gzip' });
await w.initialize();
await w.push(root);  // patches are gzip-wrapped before pushing

// Restore auto-detects compression — no flag needed on the reader side
const w2 = new WDoubleSync({ endlessVector: ev });
const folder = await w2.restore();
```

### Resume from existing chain

A new WDoubleSync instance on a populated EndlessVector rebuilds its internal state (CDC store + last snapshot) by replaying all existing items. The next push produces a diff patch — not a full patch.

```js
// Some time later, new process...
const w = new WDoubleSync({ endlessVector: ev, sync });
await w.initialize();  // replays chain to rebuild state
await w.push(updatedRoot);  // produces a diff patch
```

## API

### `new WDoubleSync({ endlessVector, sync?, compress? })`

| Param | Type | Default | Description |
|---|---|---|---|
| `endlessVector` | `EndlessVector` | required | EndlessVector instance (read-only or read+write) |
| `sync` | `DoubleSync` | `new DoubleSync()` | DoubleSync instance with CDC parameters |
| `compress` | `'gzip'` \| `false` | `false` | Wrap patches in gzip before pushing |

### `initialize(): Promise<void>`

Load EndlessVector state and rebuild internal CDC store + session by replaying existing chain items. Safe to call multiple times.

### `push(root, params?): Promise<{ version: number }>`

Build the next patch from `root` and push it to the EndlessVector. Auto-initializes if needed.

### `restore(version?): Promise<DoubleSyncMemoryFolder>`

Reconstruct the folder tree by replaying patches from the chain. Defaults to latest version.

### `length(): Promise<number>`

Number of patch versions stored on chain.

### `getPatch(index): Promise<Uint8Array>`

Raw patch bytes at the given chain index.

### `reInitialize()`

Force full state reset. Next `initialize()` replays the chain from scratch.

## Testing

Tests run against a real local Sui blockchain node using the same infrastructure as EndlessVector's own test suite:

```bash
pnpm test
```

Requires the `seal_walrus_localnet` setup at `../seal_walrus_localnet/` and the `endless_vector` Move package at `../endless_vector/move/`.

## Dependencies

- [doublesync](https://github.com/FizzyFlow/doublesync) — CDC chunking, snapshot/patch encoding, folder-tree diff
- [endless_vector](https://github.com/fizzyFlow/endless_vector) — on-chain append-only vector with auto history/archive/Walrus management
