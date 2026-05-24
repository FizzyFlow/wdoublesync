import crypto from 'crypto';

function equalUint8Arrays(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function randomBytesOfLength(length) {
    return new Uint8Array(crypto.randomBytes(length));
}

/**
 * Deterministic pseudo-random bytes via xorshift32 (for reproducible tree content).
 * @param {number} n
 * @param {number} [seed=1]
 * @returns {Uint8Array}
 */
function seededBytes(n, seed = 1) {
    let s = (seed * 2654435761) >>> 0;
    if (s === 0) s = 0xdeadbeef;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        out[i] = s & 0xff;
    }
    return out;
}

/**
 * Walk a DoubleSyncFolder and return all files as `{ path, bytes }`.
 */
async function collectTree(folder, prefix = []) {
    const out = [];
    for await (const { path, file } of folder.walk(prefix)) {
        out.push({ path, bytes: await file.getContent() });
    }
    return out;
}

/**
 * Compare two DoubleSyncFolder trees for byte-level equality.
 */
async function treesEqual(a, b) {
    const ta = await collectTree(a);
    const tb = await collectTree(b);
    if (ta.length !== tb.length) return false;
    for (let i = 0; i < ta.length; i++) {
        if (ta[i].path.join('/') !== tb[i].path.join('/')) return false;
        if (!equalUint8Arrays(ta[i].bytes, tb[i].bytes)) return false;
    }
    return true;
}

export {
    equalUint8Arrays,
    randomBytesOfLength,
    seededBytes,
    collectTree,
    treesEqual,
};
