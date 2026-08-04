import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { join, normalize, resolve } from 'path';
import { getPluginData } from '../../config.mjs';
import { writeJsonAtomicSync } from '../../../../shared/atomic-file.mjs';

const READ_RANGE_INDEX_STRIDE_LINES = 4096;
const READ_RANGE_INDEX_MAX_ENTRIES = 64;
const READ_RANGE_INDEX_DISK_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const READ_RANGE_INDEX_MAX_PERSISTED_ANCHORS = 8192;
const READ_RANGE_INDEX_PERSIST_DEBOUNCE_MS = 750;

const READ_RANGE_INDEX_CACHE = new Map();
const READ_RANGE_INDEX_PERSIST_PENDING = new Map();
let readRangeIndexDiskSwept = false;

let traceReadRangeIndex = () => {};
let hashTextForTrace = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');

export function configureReadRangeIndexTelemetry({ trace, hashText } = {}) {
    if (typeof trace === 'function') traceReadRangeIndex = trace;
    if (typeof hashText === 'function') hashTextForTrace = hashText;
}

function canonicalCachePath(p) {
    const full = normalize(resolve(String(p || '')));
    return process.platform === 'win32' ? full.toLowerCase() : full;
}

const READ_RANGE_INDEX_DISK_DIR = (() => {
    try {
        const dir = join(getPluginData(), 'read-range-index');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return dir;
    } catch { return null; }
})();

function readRangeIndexFilePath(fullPath) {
    if (!READ_RANGE_INDEX_DISK_DIR || !fullPath) return null;
    const key = createHash('sha256').update(canonicalCachePath(fullPath)).digest('hex');
    return join(READ_RANGE_INDEX_DISK_DIR, `${key}.json`);
}

function serialiseReadRangeIndex(index) {
    if (!index || !index.fullPath || !index.anchors) return null;
    const anchors = [...index.anchors.entries()]
        .filter(([line, byteOffset]) => Number.isFinite(line) && Number.isFinite(byteOffset) && line >= 0 && byteOffset >= 0)
        .sort((a, b) => a[0] - b[0])
        .slice(-READ_RANGE_INDEX_MAX_PERSISTED_ANCHORS);
    if (!anchors.some(([line]) => line === 0)) anchors.unshift([0, 0]);
    return {
        version: 1,
        path: index.fullPath,
        size: index.size,
        mtimeMs: index.mtimeMs,
        prefixHash: index.prefixHash || '',
        totalLines: Number.isFinite(index.totalLines) ? index.totalLines : undefined,
        anchors,
    };
}

function readRangeIndexMatches(row, fullPath, st) {
    return row
        && row.version === 1
        && row.path === fullPath
        && typeof row.size === 'number'
        && row.size === st.size
        && Number.isFinite(row.mtimeMs)
        && Math.abs(row.mtimeMs - st.mtimeMs) <= 1
        && Array.isArray(row.anchors);
}

// Hash the first up to 64KiB of the file using the same sha256-of-bytes
// convention as the streaming readers (read-streaming.mjs / read-windows.mjs)
// so a value computed here can be compared byte-for-byte against the
// `prefixHash` they persist into the anchor index.
function computePrefixHashForIndex(fullPath, st) {
    try {
        const cap = Math.min(Number(st?.size) || 0, 65536);
        if (cap <= 0) return '';
        const fd = openSync(fullPath, 'r');
        try {
            const buf = Buffer.allocUnsafe(cap);
            const bytesRead = readSync(fd, buf, 0, cap, 0);
            if (bytesRead <= 0) return '';
            return createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
        } finally {
            try { closeSync(fd); } catch {}
        }
    } catch {
        return '';
    }
}

function ensureReadRangeIndexDiskSwept() {
    if (readRangeIndexDiskSwept) return;
    readRangeIndexDiskSwept = true;
    sweepStaleReadRangeIndexes();
}

function loadReadRangeIndexFromDisk(fullPath, st) {
    ensureReadRangeIndexDiskSwept();
    const file = readRangeIndexFilePath(fullPath);
    // No existsSync preflight: a missing file surfaces as an ENOENT from
    // readFileSync below, caught by the same try/catch — one FS pass, not two.
    if (!file || !st) return null;
    try {
        const row = JSON.parse(readFileSync(file, 'utf-8'));
        if (!readRangeIndexMatches(row, fullPath, st)) return null;
        // Anchors are byte offsets into the file. A same-size / same-mtime
        // rewrite (touch-restore, in-place edit of equal-length content)
        // leaves the stat gate above happy but invalidates every persisted
        // byte offset, causing seeks to land on the wrong line. When the
        // persisted index carries a prefixHash, the current file's prefix
        // must match; on mismatch drop the on-disk row so the caller
        // rebuilds from scratch.
        if (typeof row.prefixHash === 'string' && row.prefixHash) {
            const cur = computePrefixHashForIndex(fullPath, st);
            if (!cur || cur !== row.prefixHash) {
                try { unlinkSync(file); } catch {}
                return null;
            }
        }
        const anchors = new Map([[0, 0]]);
        for (const entry of row.anchors) {
            if (!Array.isArray(entry) || entry.length < 2) continue;
            const line = Number(entry[0]);
            const byteOffset = Number(entry[1]);
            if (!Number.isFinite(line) || !Number.isFinite(byteOffset) || line < 0 || byteOffset < 0) continue;
            anchors.set(line, byteOffset);
        }
        const loaded = {
            fullPath,
            size: st.size,
            mtimeMs: st.mtimeMs,
            prefixHash: typeof row.prefixHash === 'string' ? row.prefixHash : '',
            anchors,
        };
        if (Number.isFinite(row.totalLines)) loaded.totalLines = row.totalLines;
        traceReadRangeIndex('read_range_index_load', {
            pathHash: hashTextForTrace(fullPath).slice(0, 12),
            anchors: anchors.size,
            bytes: st.size,
        });
        return loaded;
    } catch { return null; }
}

function persistReadRangeIndexSync(index) {
    const file = readRangeIndexFilePath(index?.fullPath);
    if (!file) return;
    const row = serialiseReadRangeIndex(index);
    if (!row) return;
    try { writeJsonAtomicSync(file, row, { compact: true, lock: true, fsync: false }); } catch {}
}

export function scheduleReadRangeIndexPersist(index) {
    if (!READ_RANGE_INDEX_DISK_DIR || !index?.fullPath) return;
    const key = canonicalCachePath(index.fullPath);
    if (READ_RANGE_INDEX_PERSIST_PENDING.has(key)) return;
    const t = setTimeout(() => {
        READ_RANGE_INDEX_PERSIST_PENDING.delete(key);
        persistReadRangeIndexSync(index);
    }, READ_RANGE_INDEX_PERSIST_DEBOUNCE_MS);
    if (t.unref) t.unref();
    READ_RANGE_INDEX_PERSIST_PENDING.set(key, t);
}

export function flushReadRangeIndexesSync() {
    for (const [key, timer] of READ_RANGE_INDEX_PERSIST_PENDING) {
        try { clearTimeout(timer); } catch {}
        READ_RANGE_INDEX_PERSIST_PENDING.delete(key);
        const index = READ_RANGE_INDEX_CACHE.get(key);
        if (index) persistReadRangeIndexSync(index);
    }
}

export function deleteReadRangeIndexForPath(fullPath) {
    const key = canonicalCachePath(fullPath);
    READ_RANGE_INDEX_CACHE.delete(key);
    const timer = READ_RANGE_INDEX_PERSIST_PENDING.get(key);
    if (timer) {
        try { clearTimeout(timer); } catch {}
        READ_RANGE_INDEX_PERSIST_PENDING.delete(key);
    }
    const file = readRangeIndexFilePath(fullPath);
    if (file) {
        try { if (existsSync(file)) unlinkSync(file); } catch {}
    }
}

function sweepStaleReadRangeIndexes() {
    if (!READ_RANGE_INDEX_DISK_DIR) return;
    let entries;
    try { entries = readdirSync(READ_RANGE_INDEX_DISK_DIR); }
    catch { return; }
    const now = Date.now();
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const full = join(READ_RANGE_INDEX_DISK_DIR, name);
        try {
            const st = statSync(full);
            if (now - st.mtimeMs > READ_RANGE_INDEX_DISK_STALE_MS) unlinkSync(full);
        } catch {}
    }
}

export function getReadRangeIndex(fullPath, st) {
    if (!st) return null;
    const key = canonicalCachePath(fullPath);
    const cached = READ_RANGE_INDEX_CACHE.get(key);
    if (cached && cached.size === st.size && Math.abs(cached.mtimeMs - st.mtimeMs) <= 1) {
        // In-memory anchors share the same byte-offset hazard as the
        // on-disk row: a same-size / same-mtime overwrite would otherwise
        // be reused with the wrong offsets. When a prefixHash was recorded
        // for the cached index, verify it before refreshing the LRU slot;
        // on mismatch evict and fall through to disk-load / fresh rebuild.
        // When prefixHash is empty (e.g. a freshly-created index that no
        // streaming read has populated yet) keep the prior stat-only
        // behavior so genuinely unchanged files are not re-walked.
        if (cached.prefixHash) {
            const cur = computePrefixHashForIndex(fullPath, st);
            if (!cur || cur !== cached.prefixHash) {
                READ_RANGE_INDEX_CACHE.delete(key);
            } else {
                READ_RANGE_INDEX_CACHE.delete(key);
                READ_RANGE_INDEX_CACHE.set(key, cached);
                return cached;
            }
        } else {
            READ_RANGE_INDEX_CACHE.delete(key);
            READ_RANGE_INDEX_CACHE.set(key, cached);
            return cached;
        }
    }
    const loaded = loadReadRangeIndexFromDisk(fullPath, st);
    if (loaded) {
        READ_RANGE_INDEX_CACHE.set(key, loaded);
        return loaded;
    }
    const fresh = { fullPath, size: st.size, mtimeMs: st.mtimeMs, prefixHash: '', anchors: new Map([[0, 0]]) };
    READ_RANGE_INDEX_CACHE.set(key, fresh);
    while (READ_RANGE_INDEX_CACHE.size > READ_RANGE_INDEX_MAX_ENTRIES) {
        const oldest = READ_RANGE_INDEX_CACHE.keys().next().value;
        const oldIndex = READ_RANGE_INDEX_CACHE.get(oldest);
        if (oldIndex) persistReadRangeIndexSync(oldIndex);
        READ_RANGE_INDEX_CACHE.delete(oldest);
    }
    return fresh;
}

export function nearestReadRangeAnchor(index, offset) {
    let bestLine = 0;
    let bestByteOffset = 0;
    if (!index || !index.anchors) return { line: bestLine, byteOffset: bestByteOffset };
    for (const [line, byteOffset] of index.anchors) {
        if (line <= offset && line >= bestLine) {
            bestLine = line;
            bestByteOffset = byteOffset;
        }
    }
    return { line: bestLine, byteOffset: bestByteOffset };
}

export function maybeRecordReadRangeAnchor(index, line, byteOffset) {
    if (!index || !Number.isFinite(line) || !Number.isFinite(byteOffset)) return;
    if (line < 0 || byteOffset < 0) return;
    if (line === 0 || line % READ_RANGE_INDEX_STRIDE_LINES === 0) {
        if (index.anchors.get(line) === byteOffset) return;
        index.anchors.set(line, byteOffset);
        scheduleReadRangeIndexPersist(index);
    }
}
