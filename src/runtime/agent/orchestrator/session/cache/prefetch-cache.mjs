// Cross-dispatch prefetch cache. Memory-first; disk-backed so a process
// restart (mcp child respawn / reload-plugins / dev-sync child kill) does
// not start cold. Keyed by canonical absolute path; stores raw read-tool
// output per file. Disk entries are stat-validated on read just like the
// memory entries, so an external write to the source file invalidates the
// cached slice automatically.
import { classifyResultKind } from '../result-classification.mjs';
import { _normalizeAbs, _normalizeCacheKey, _statTuple, _statEqual } from './util.mjs';
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { readdir, stat as statAsync, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { writeJsonAtomicSync } from '../../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';

// I: cap is configurable via MIXDOG_PREFETCH_CACHE_MAX env var; default 200.
const _envCap = Number(process.env.MIXDOG_PREFETCH_CACHE_MAX);
const PREFETCH_CACHE_MAX = (Number.isFinite(_envCap) && _envCap > 0) ? _envCap : 200;
const PREFETCH_TTL_MS_DEFAULT = 60 * 60 * 1000; // 1 hour
let _prefetchTtlMs = PREFETCH_TTL_MS_DEFAULT;

// absPath → { content: string, stat: _statTuple, ts: number }
const _prefetchCache = new Map();
const _pendingDiskWrites = new Map();
let _diskWriteTimer = null;

const DISK_CACHE_DIR = join(resolvePluginData(), 'cache', 'prefetch');
// Disk GC: an entry is only unlinked when something looks it up again and
// finds it stale, so files for paths that are never re-read (or whose process
// died) sit in cache/prefetch forever. Sweep past-TTL files on an interval.
const DISK_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let _diskSweptAt = 0;
async function _sweepDiskCache() {
    let names;
    try { names = await readdir(DISK_CACHE_DIR); } catch { return; }
    const cutoff = Date.now() - _prefetchTtlMs;
    await Promise.all(names.map(async (name) => {
        if (!name.endsWith('.json')) return;
        const p = join(DISK_CACHE_DIR, name);
        try {
            const st = await statAsync(p);
            if (st.mtimeMs < cutoff) await unlink(p).catch(() => {});
        } catch { /* raced with another sweep */ }
    }));
}
function _maybeSweepDiskCache() {
    const now = Date.now();
    if (now - _diskSweptAt < DISK_SWEEP_INTERVAL_MS) return;
    _diskSweptAt = now;
    void _sweepDiskCache();
}
function _diskPath(absPath) {
    const hash = createHash('sha256').update(absPath).digest('hex');
    return join(DISK_CACHE_DIR, `${hash}.json`);
}
function _readDiskEntry(absPath) {
    const p = _diskPath(absPath);
    if (!existsSync(p)) return null;
    try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        if (!parsed || parsed.absPath !== absPath || typeof parsed.content !== 'string' || !parsed.stat) return null;
        return { content: parsed.content, stat: parsed.stat, ts: parsed.ts };
    } catch { return null; }
}
function _writeDiskEntryNow(absPath, entry) {
    const p = _diskPath(absPath);
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeJsonAtomicSync(p, { absPath, ...entry }, { compact: true, fsync: false });
    } catch { /* best-effort — disk persist failure must never break in-memory path */ }
}
function _flushDiskWrites() {
    _diskWriteTimer = null;
    if (_pendingDiskWrites.size === 0) return;
    const batch = [..._pendingDiskWrites.entries()];
    _pendingDiskWrites.clear();
    for (const [absPath, entry] of batch) _writeDiskEntryNow(absPath, entry);
}
function _scheduleDiskWrite(absPath, entry) {
    _pendingDiskWrites.set(absPath, entry);
    if (_diskWriteTimer !== null) return;
    const t = setTimeout(_flushDiskWrites, 100);
    if (typeof t.unref === 'function') t.unref();
    _diskWriteTimer = t;
}
function _deleteDiskEntry(absPath) {
    _pendingDiskWrites.delete(absPath);
    try { unlinkSync(_diskPath(absPath)); } catch { /* missing is fine */ }
}

/**
 * Look up a cached prefetch result for `absPath`. Stat-validates the file on
 * every hit. Returns null on miss, TTL expiry, or stat mismatch. Returns
 * `{ content, ts }` on a fresh hit.
 */
export function tryPrefetchCached(absPath) {
    if (typeof absPath !== 'string' || absPath.length === 0) return null;
    _maybeSweepDiskCache();
    absPath = _normalizeCacheKey(absPath);
    let entry = _prefetchCache.get(absPath);
    if (!entry) {
        // Memory miss — fall through to disk so a fresh process can still hit.
        const disk = _readDiskEntry(absPath);
        if (!disk) return null;
        entry = disk;
        _prefetchCache.set(absPath, entry);
    }
    if (Date.now() - entry.ts > _prefetchTtlMs) {
        _prefetchCache.delete(absPath);
        _deleteDiskEntry(absPath);
        return null;
    }
    const fresh = _statTuple(absPath);
    if (!_statEqual(entry.stat, fresh)) {
        _prefetchCache.delete(absPath);
        _deleteDiskEntry(absPath);
        return null;
    }
    // LRU touch: move to end of insertion-order sequence.
    _prefetchCache.delete(absPath);
    _prefetchCache.set(absPath, entry);
    return { content: entry.content, ts: entry.ts };
}

/**
 * Store a per-file prefetch result. Silently skips empty or error-prefixed
 * content so only clean read output enters the cache.
 */
export function setPrefetchCached(absPath, content) {
    if (typeof absPath !== 'string' || absPath.length === 0) return;
    if (typeof content !== 'string' || content.length === 0) return;
    if (classifyResultKind(content) === 'error') return;
    absPath = _normalizeCacheKey(absPath);
    const stat = _statTuple(absPath);
    if (!stat) return;
    if (_prefetchCache.size >= PREFETCH_CACHE_MAX) {
        const firstKey = _prefetchCache.keys().next().value;
        if (firstKey !== undefined) {
            _prefetchCache.delete(firstKey);
            _deleteDiskEntry(firstKey);
        }
    }
    const entry = { content, stat, ts: Date.now() };
    _prefetchCache.set(absPath, entry);
    _scheduleDiskWrite(absPath, entry);
}

/**
 * Drop the cache entry for `path` (cross-session). Called from loop.mjs
 * wherever a write-class tool invalidates a path.
 */
export function invalidatePrefetchCache(path, cwd) {
    if (typeof path !== 'string' || path.length === 0) return;
    const abs = _normalizeAbs(path, cwd);
    if (!abs) return;
    _prefetchCache.delete(abs);
    _deleteDiskEntry(abs);
}

export function drainPrefetchDiskWrites() {
    if (_diskWriteTimer !== null) {
        clearTimeout(_diskWriteTimer);
        _diskWriteTimer = null;
    }
    _flushDiskWrites();
}

try { process.once('beforeExit', drainPrefetchDiskWrites); } catch {}
