import { statSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'path';
import { deleteReadRangeIndexForPath } from './read-range-index.mjs';
import { resolveAgainstCwd } from './path-utils.mjs';

const RESULT_CACHE = new Map(); // key → { ts, value, paths, scopes, readSnapshotMeta, contentPrefixHash, bytes }
const RESULT_CACHE_INFLIGHT = new Map(); // key → Promise<value>
const RESULT_CACHE_TTL_MS = 30_000;
const RESULT_CACHE_MAX_ENTRIES = 200;
const RESULT_CACHE_MAX_BYTES = (() => {
    const rawBytes = Number(process.env.MIXDOG_RESULT_CACHE_MAX_BYTES);
    if (Number.isFinite(rawBytes) && rawBytes > 0) return Math.trunc(rawBytes);
    const rawMb = Number(process.env.MIXDOG_RESULT_CACHE_MAX_MB);
    if (Number.isFinite(rawMb) && rawMb > 0) return Math.trunc(rawMb * 1024 * 1024);
    return 32 * 1024 * 1024;
})();
let RESULT_CACHE_BYTES = 0;
function estimateResultBytes(value) {
    if (value == null) return 0;
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf-8');
    if (Buffer.isBuffer(value)) return value.length;
    try { return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf-8'); }
    catch { return 0; }
}
function resultCacheDelete(key) {
    const entry = RESULT_CACHE.get(key);
    if (entry && typeof entry.bytes === 'number') {
        RESULT_CACHE_BYTES = Math.max(0, RESULT_CACHE_BYTES - entry.bytes);
    }
    RESULT_CACHE.delete(key);
}
const STAT_CACHE = new Map(); // fullPath → { ts, stat }
const STAT_CACHE_TTL_MS = 5_000;
const STAT_CACHE_MAX_ENTRIES = 2_000;
const RAW_CONTENT_CACHE = new Map(); // fullPath → { ts, mtimeMs, ctimeMs, size, rawBuf }
const RAW_CONTENT_CACHE_TTL_MS = 30_000;
const RAW_CONTENT_CACHE_MAX_ENTRIES = 16;
const PATH_MUTATION_GENERATIONS = new Map(); // canonical path/root → monotonic generation
const PATH_MUTATION_GENERATION_MAX_ENTRIES = 4096;
let PATH_MUTATION_GLOBAL_GENERATION = 0;
const RAW_CONTENT_CACHE_MAX_BYTES = (() => {
    const rawBytes = Number(process.env.MIXDOG_RAW_CONTENT_CACHE_MAX_BYTES);
    if (Number.isFinite(rawBytes) && rawBytes > 0) return Math.trunc(rawBytes);
    const rawMb = Number(process.env.MIXDOG_RAW_CONTENT_CACHE_MAX_MB);
    if (Number.isFinite(rawMb) && rawMb > 0) return Math.trunc(rawMb * 1024 * 1024);
    return 64 * 1024 * 1024;
})();
let RAW_CONTENT_CACHE_BYTES = 0;

function canonicalCachePath(p) {
    const full = normalize(resolve(String(p || '')));
    return process.platform === 'win32' ? full.toLowerCase() : full;
}

function normalizeCacheMetaPaths(values) {
    if (!Array.isArray(values)) return [];
    return Array.from(new Set(
        values
            .filter(Boolean)
            .map((v) => canonicalCachePath(v)),
    ));
}

function cachePathsOverlap(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`)
        || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}

function bumpPathMutationGeneration(path) {
    const key = canonicalCachePath(path);
    PATH_MUTATION_GENERATIONS.set(key, (PATH_MUTATION_GENERATIONS.get(key) || 0) + 1);
    while (PATH_MUTATION_GENERATIONS.size > PATH_MUTATION_GENERATION_MAX_ENTRIES) {
        const oldest = PATH_MUTATION_GENERATIONS.keys().next().value;
        if (!oldest) break;
        PATH_MUTATION_GENERATIONS.delete(oldest);
    }
}

export function getPathMutationGeneration(path) {
    const key = canonicalCachePath(path);
    let generation = PATH_MUTATION_GLOBAL_GENERATION;
    for (const [changedPath, value] of PATH_MUTATION_GENERATIONS) {
        if (cachePathsOverlap(key, changedPath)) generation += value;
    }
    return generation;
}

function cacheEntryOverlapsPaths(entry, affectedPaths) {
    const entryPaths = Array.isArray(entry?.paths) ? entry.paths : [];
    const entryScopes = Array.isArray(entry?.scopes) ? entry.scopes : [];
    for (const affected of affectedPaths) {
        for (const p of entryPaths) {
            if (cachePathsOverlap(p, affected)) return true;
        }
        for (const scope of entryScopes) {
            if (cachePathsOverlap(scope, affected)) return true;
        }
    }
    return false;
}

export function cacheGetEntry(key) {
    const entry = RESULT_CACHE.get(key);
    if (!entry) {
        return null;
    }
    if (Date.now() - entry.ts > RESULT_CACHE_TTL_MS) {
        resultCacheDelete(key);
        return null;
    }
    return entry;
}

export function cacheGet(key) {
    return cacheGetEntry(key)?.value ?? null;
}

export function cacheSet(key, value, meta = {}) {
    // Replace-in-place: clear old entry's byte accounting before write.
    if (RESULT_CACHE.has(key)) resultCacheDelete(key);
    const bytes = estimateResultBytes(value);
    RESULT_CACHE.set(key, {
        ts: Date.now(),
        value,
        paths: normalizeCacheMetaPaths(meta.paths),
        scopes: normalizeCacheMetaPaths(meta.scopes),
        readSnapshotMeta: meta.readSnapshotMeta || null,
        contentPrefixHash: meta.contentPrefixHash || '',
        bytes,
    });
    RESULT_CACHE_BYTES += bytes;
    // Evict oldest (insertion-order) entries until under both the entry
    // count cap and the byte budget. Mirrors RAW_CONTENT_CACHE shape.
    while (RESULT_CACHE.size > RESULT_CACHE_MAX_ENTRIES || RESULT_CACHE_BYTES > RESULT_CACHE_MAX_BYTES) {
        const oldest = RESULT_CACHE.keys().next().value;
        if (!oldest || oldest === key) break;
        resultCacheDelete(oldest);
    }
}

export async function runResultCacheInFlight(key, compute) {
    const cached = cacheGet(key);
    if (cached !== null) return cached;
    const existing = RESULT_CACHE_INFLIGHT.get(key);
    if (existing) return await existing;
    const promise = Promise.resolve()
        .then(() => compute())
        .finally(() => {
            if (RESULT_CACHE_INFLIGHT.get(key) === promise) {
                RESULT_CACHE_INFLIGHT.delete(key);
            }
        });
    RESULT_CACHE_INFLIGHT.set(key, promise);
    return await promise;
}

function rawContentCacheDelete(key) {
    const entry = RAW_CONTENT_CACHE.get(key);
    if (entry?.rawBuf) RAW_CONTENT_CACHE_BYTES = Math.max(0, RAW_CONTENT_CACHE_BYTES - entry.rawBuf.length);
    RAW_CONTENT_CACHE.delete(key);
}

export function rawContentCacheGet(fullPath, stat, now = Date.now()) {
    if (!fullPath || !stat) return null;
    const key = canonicalCachePath(fullPath);
    const entry = RAW_CONTENT_CACHE.get(key);
    if (!entry) return null;
    if (now - entry.ts > RAW_CONTENT_CACHE_TTL_MS) {
        rawContentCacheDelete(key);
        return null;
    }
    if (entry.size !== stat.size
        || Math.abs(entry.mtimeMs - stat.mtimeMs) > 1
        || Math.abs(entry.ctimeMs - stat.ctimeMs) > 1) {
        rawContentCacheDelete(key);
        return null;
    }
    RAW_CONTENT_CACHE.delete(key);
    RAW_CONTENT_CACHE.set(key, entry);
    return entry.rawBuf;
}

export function rawContentCacheSet(fullPath, stat, rawBuf, now = Date.now()) {
    if (!fullPath || !stat || !Buffer.isBuffer(rawBuf)) return;
    if (rawBuf.length > RAW_CONTENT_CACHE_MAX_BYTES) return;
    const key = canonicalCachePath(fullPath);
    rawContentCacheDelete(key);
    RAW_CONTENT_CACHE.set(key, {
        ts: now,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        size: stat.size,
        rawBuf,
    });
    RAW_CONTENT_CACHE_BYTES += rawBuf.length;
    while (RAW_CONTENT_CACHE.size > RAW_CONTENT_CACHE_MAX_ENTRIES || RAW_CONTENT_CACHE_BYTES > RAW_CONTENT_CACHE_MAX_BYTES) {
        const oldest = RAW_CONTENT_CACHE.keys().next().value;
        if (!oldest) break;
        rawContentCacheDelete(oldest);
    }
}

export function seedRawContentCacheAfterWrite(fullPath, content, st = null) {
    try {
        const rawBuf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf-8');
        const writtenStat = st && typeof st.size === 'number' ? st : statSync(fullPath);
        rawContentCacheSet(fullPath, writtenStat, rawBuf);
        return writtenStat;
    } catch { return st || null; }
}

function statCacheGet(fullPath, now = Date.now()) {
    const entry = STAT_CACHE.get(fullPath);
    if (!entry) return null;
    if (now - entry.ts > STAT_CACHE_TTL_MS) {
        STAT_CACHE.delete(fullPath);
        return null;
    }
    return entry.stat;
}

export function statCacheSet(fullPath, stat, now = Date.now()) {
    if (STAT_CACHE.size >= STAT_CACHE_MAX_ENTRIES) {
        const oldest = STAT_CACHE.keys().next().value;
        if (oldest) STAT_CACHE.delete(oldest);
    }
    STAT_CACHE.set(fullPath, { ts: now, stat });
}

export function getCachedReadOnlyStat(fullPath, loader = statSync, now = Date.now()) {
    const cached = statCacheGet(fullPath, now);
    if (cached) return cached;
    const stat = loader(fullPath);
    statCacheSet(fullPath, stat, now);
    return stat;
}

export async function statPathsForMtime(paths, workDir, concurrency = 64, opts = {}) {
    const items = Array.isArray(paths) ? paths : [];
    const out = new Array(items.length);
    const now = Date.now();
    const inflight = new Map();
    let next = 0;
    // Hard per-stat deadline (0 = disabled, legacy behaviour). A hung stat
    // (dead mount / unresponsive network path) must not pin a worker forever;
    // on expiry the entry resolves to null (stat-failed) so glob's post-rg stat
    // phase is bounded instead of running to the 600s agent watchdog.
    const deadlineMs = Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : 0;
    // Injectable stat impl for testing hung-FS behaviour deterministically.
    const statImpl = typeof opts._statImpl === 'function' ? opts._statImpl : fsPromises.stat;

    async function resolveStat(full) {
        let pending = inflight.get(full);
        if (!pending) {
            const statBase = statImpl(full)
                .then((stat) => {
                    statCacheSet(full, stat, now);
                    return stat;
                })
                .catch(() => null);
            let base = statBase;
            if (deadlineMs > 0) {
                // ref timer (not unref): the deadline MUST fire even when the
                // hung stat is the only pending work — that is exactly the case
                // we bound. clearTimeout on the normal path keeps a fast stat
                // from holding the loop for the full deadline window.
                base = new Promise((resolve) => {
                    let settled = false;
                    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, deadlineMs);
                    statBase.then((v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } });
                });
            }
            pending = base;
            inflight.set(full, pending);
        }
        return pending;
    }

    async function worker() {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            const p = items[index];
            const full = isAbsolute(p) ? p : resolveAgainstCwd(p, workDir);
            try {
                const stat = await resolveStat(full);
                if (!stat) throw new Error('stat failed');
                out[index] = { path: p, full, stat, size: stat.size, mtime: stat.mtimeMs, mtimeMs: stat.mtimeMs };
            } catch {
                out[index] = { path: p, full, stat: null, size: 0, mtime: 0, mtimeMs: 0 };
            }
        }
    }
    const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
    await Promise.all(Array.from({ length: workerCount }, worker));
    return out;
}

// lstat variant — does NOT follow symlinks. Use for directory-listing
// surfaces where a symlink to a 200 GB file should report as a symlink,
// not as the target's size/mtime.
export async function lstatPathsForMtime(paths, workDir, concurrency = 64, opts = {}) {
    const items = Array.isArray(paths) ? paths : [];
    const out = new Array(items.length);
    const inflight = new Map();
    let next = 0;
    // Hard per-lstat deadline (0 = disabled, legacy behaviour). A hung lstat
    // (dead mount / unresponsive network path) must not pin a worker forever;
    // on expiry the entry resolves to null (stat-failed) so list's stat phase
    // is bounded instead of running to the 600s agent watchdog.
    const deadlineMs = Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : 0;
    // Injectable lstat impl for testing hung-FS behaviour deterministically.
    const lstatImpl = typeof opts._lstatImpl === 'function' ? opts._lstatImpl : fsPromises.lstat;

    async function resolveLstat(full) {
        let pending = inflight.get(full);
        if (!pending) {
            const lstatBase = lstatImpl(full).catch(() => null);
            let base = lstatBase;
            if (deadlineMs > 0) {
                // ref timer (not unref): the deadline MUST fire even when the
                // hung lstat is the only pending work — that is exactly the case
                // we bound. clearTimeout on the normal path keeps a fast lstat
                // from holding the loop for the full deadline window.
                base = new Promise((resolve) => {
                    let settled = false;
                    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, deadlineMs);
                    lstatBase.then((v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } });
                });
            }
            pending = base;
            inflight.set(full, pending);
        }
        return pending;
    }

    async function worker() {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            const p = items[index];
            const full = isAbsolute(p) ? p : resolveAgainstCwd(p, workDir);
            try {
                const stat = await resolveLstat(full);
                if (!stat) throw new Error('lstat failed');
                out[index] = { path: p, full, stat, size: stat.size, mtime: stat.mtimeMs, mtimeMs: stat.mtimeMs };
            } catch {
                out[index] = { path: p, full, stat: null, size: 0, mtime: 0, mtimeMs: 0 };
            }
        }
    }
    const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
    await Promise.all(Array.from({ length: workerCount }, worker));
    return out;
}

// Extra invalidation listeners: sibling modules with their own derived caches
// (e.g. the broad find-enumeration cache in list-tool) register a clear
// callback here so every write-invalidation event that drops the result/stat/
// raw caches also drops theirs. Full clear is intentional — those entries are
// cheap to rebuild and a path-scoped diff is not worth the coupling.
const EXTRA_INVALIDATION_LISTENERS = new Set();
export function registerCacheInvalidationListener(fn) {
    if (typeof fn === 'function') EXTRA_INVALIDATION_LISTENERS.add(fn);
    return () => EXTRA_INVALIDATION_LISTENERS.delete(fn);
}
function runExtraInvalidationListeners() {
    for (const fn of EXTRA_INVALIDATION_LISTENERS) {
        try { fn(); } catch { /* best-effort: one listener must not block others */ }
    }
}

function cacheInvalidateAll() {
    RESULT_CACHE.clear();
    RESULT_CACHE_INFLIGHT.clear();
    RESULT_CACHE_BYTES = 0;
    STAT_CACHE.clear();
    RAW_CONTENT_CACHE.clear();
    RAW_CONTENT_CACHE_BYTES = 0;
    PATH_MUTATION_GENERATIONS.clear();
    PATH_MUTATION_GLOBAL_GENERATION += 1;
    runExtraInvalidationListeners();
}

function cacheInvalidatePaths(paths) {
    const affectedPaths = normalizeCacheMetaPaths(Array.isArray(paths) ? paths : [paths]);
    if (affectedPaths.length === 0) {
        cacheInvalidateAll();
        return;
    }
    RESULT_CACHE_INFLIGHT.clear();
    for (const [key, entry] of RESULT_CACHE) {
        if (cacheEntryOverlapsPaths(entry, affectedPaths)) {
            resultCacheDelete(key);
        }
    }
    for (const key of [...STAT_CACHE.keys()]) {
        if (affectedPaths.some((affected) => cachePathsOverlap(canonicalCachePath(key), affected))) {
            STAT_CACHE.delete(key);
        }
    }
    for (const key of [...RAW_CONTENT_CACHE.keys()]) {
        if (affectedPaths.some((affected) => cachePathsOverlap(key, affected))) {
            rawContentCacheDelete(key);
        }
    }
    for (const affected of affectedPaths) {
        deleteReadRangeIndexForPath(affected);
        bumpPathMutationGeneration(affected);
    }
    // Broad enumeration entries are not path-scoped, so any partial
    // invalidation still fully drops them (cheap to rebuild).
    runExtraInvalidationListeners();
}

export function invalidateBuiltinResultCache(paths = null) {
    if (Array.isArray(paths) ? paths.length > 0 : Boolean(paths)) {
        cacheInvalidatePaths(paths);
        return;
    }
    cacheInvalidateAll();
}
