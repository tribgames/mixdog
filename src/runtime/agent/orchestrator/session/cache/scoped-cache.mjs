// Scoped tool cache for deterministic multi-file-scope tools (grep/glob/list
// and code-graph lookups).
// Write-class tools invalidate only entries whose registered root contains the
// touched path; unknown paths still fall back to a full session clear.
import { join, resolve as _pathResolve, isAbsolute as _pathIsAbs, normalize as _pathNorm } from 'node:path';
import { writeJsonAtomicSync } from '../../../../shared/atomic-file.mjs';
import { _normalizeCacheKey } from './util.mjs';

const MAX_PER_SESSION = 100;

// sessionId -> Map<key, { content, ts, firstToolUseId, depRoots }>
const _scopedBySession = new Map();

// sessionId -> Map<absPath, Set<cacheKey>>  — reverse index for O(1) path-targeted invalidation
const _scopedReverseIdx = new Map();

// sessionId -> { sets, hits, misses, clears }
const _scopedCounters = new Map();

let _snapshotDataDir = null;
let _snapshotTimer = null;

function _canonicalArgs(args) {
    if (args === null || args === undefined) return '';
    if (typeof args !== 'object') return String(args);
    try {
        const keys = Object.keys(args).sort();
        const sorted = {};
        for (const k of keys) {
            const v = args[k];
            if (v === undefined || v === null || v === '') continue;
            sorted[k] = v;
        }
        return JSON.stringify(sorted);
    } catch { return String(args); }
}

function _firstArg(args, names) {
    for (const name of names) {
        if (args?.[name] === undefined || args?.[name] === null || args?.[name] === '') continue;
        return args[name];
    }
    return undefined;
}

function _canonicalToolArgs(toolName, args) {
    if (!args || typeof args !== 'object') return args;
    const next = { ...args };
    if (toolName === 'grep') {
        if (next.pattern === undefined || next.pattern === null || next.pattern === '') {
            const alias = _firstArg(next, ['query', 'regex', 'regexp', 'needle', 'search', 'literal']);
            if (alias !== undefined) next.pattern = alias;
        }
        if (next.glob === undefined || next.glob === null || next.glob === '') {
            const alias = _firstArg(next, ['file_pattern', 'filePattern', 'include', 'includes', 'files']);
            if (alias !== undefined) next.glob = alias;
        }
        if (next.path === undefined || next.path === null || next.path === '') {
            const alias = _firstArg(next, ['root', 'directory', 'dir']);
            if (alias !== undefined) next.path = alias;
        }
        if ((next.output_mode === undefined || next.output_mode === null || next.output_mode === '') && typeof next.mode === 'string') {
            const mode = next.mode.trim();
            if (['files_with_matches', 'content', 'count'].includes(mode)) next.output_mode = mode;
        }
        for (const k of ['query', 'regex', 'regexp', 'needle', 'search', 'literal', 'file_pattern', 'filePattern', 'include', 'includes', 'files', 'root', 'directory', 'dir']) delete next[k];
        if (next.output_mode && next.mode === next.output_mode) delete next.mode;
    } else if (toolName === 'glob') {
        if (next.pattern === undefined || next.pattern === null || next.pattern === '') {
            const alias = _firstArg(next, ['glob', 'file_pattern', 'filePattern', 'name', 'include', 'includes', 'files']);
            if (alias !== undefined) next.pattern = alias;
        }
        if (next.path === undefined || next.path === null || next.path === '') {
            const alias = _firstArg(next, ['root', 'directory', 'dir']);
            if (alias !== undefined) next.path = alias;
        }
        for (const k of ['glob', 'file_pattern', 'filePattern', 'name', 'include', 'includes', 'files', 'root', 'directory', 'dir']) delete next[k];
    }
    return next;
}

function _scopedKey(toolName, args, cwd) {
    // Include resolved cwd in the key so identical (toolName, args) pairs from
    // different working directories do not collide.
    const cwdPart = (typeof cwd === 'string' && cwd.length > 0)
        ? _normalizeCacheKey(cwd)
        : '';
    return `${toolName}|cwd=${cwdPart}|${_canonicalArgs(_canonicalToolArgs(toolName, args))}`;
}

function _hasGlobMagic(value) {
    return typeof value === 'string' && /[\*\?\[\{]/.test(value);
}

function _extractGlobRoot(value) {
    if (!_hasGlobMagic(value)) return value;
    const text = String(value);
    const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    if (slash <= 0) return '.';
    return text.slice(0, slash);
}

function _normalizeScopedAbs(value, cwd) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const base = (cwd && typeof cwd === 'string') ? cwd : process.cwd();
    try {
        const root = _extractGlobRoot(value);
        return _normalizeCacheKey(_pathNorm(_pathIsAbs(root) ? root : _pathResolve(base, root)));
    } catch {
        return null;
    }
}

function _collectPathValues(value, out) {
    if (typeof value === 'string' && value.length > 0) {
        out.push(value);
    } else if (Array.isArray(value)) {
        for (const item of value) _collectPathValues(item, out);
    }
}

function _scopedDependencyRoots(toolName, args, cwd) {
    const roots = new Set();
    const add = (value) => {
        const abs = _normalizeScopedAbs(value, cwd);
        if (abs) roots.add(abs);
    };
    const canonicalArgs = _canonicalToolArgs(toolName, args);
    const rawPaths = [];
    if (canonicalArgs && typeof canonicalArgs === 'object') {
        _collectPathValues(canonicalArgs.file, rawPaths);
        _collectPathValues(canonicalArgs.path, rawPaths);
        _collectPathValues(canonicalArgs.root, rawPaths);
    }
    if (rawPaths.length > 0) {
        for (const p of rawPaths) add(p);
        // `glob` results are gated on the pattern's static (non-magic) prefix,
        // not just cwd/path root — a pattern like "src/**/*.mjs" must register
        // "src", not just cwd, or edits under src/ that are not directly under
        // the given path root will not invalidate the cached glob result.
        if (toolName === 'glob' && canonicalArgs && typeof canonicalArgs.pattern !== 'undefined') {
            const patterns = [];
            _collectPathValues(canonicalArgs.pattern, patterns);
            for (const pattern of patterns) {
                if (typeof pattern !== 'string' || !_hasGlobMagic(pattern)) continue;
                const patternRoot = _extractGlobRoot(pattern);
                if (_pathIsAbs(patternRoot)) {
                    add(patternRoot);
                } else if (rawPaths.length > 0) {
                    for (const p of rawPaths) add(join(p, patternRoot));
                } else {
                    add(patternRoot);
                }
            }
        }
    } else if (cwd && typeof cwd === 'string') {
        add(cwd);
    }
    return [...roots];
}

function _pathTouchesRoot(absPath, root) {
    if (!absPath || !root) return false;
    return absPath === root || absPath.startsWith(`${root}/`);
}

function _bumpCounter(sessionId, field) {
    let c = _scopedCounters.get(sessionId);
    if (!c) {
        c = { sets: 0, hits: 0, misses: 0, clears: 0 };
        _scopedCounters.set(sessionId, c);
    }
    c[field] = (c[field] ?? 0) + 1;
    _scheduleCacheStatsFlush();
}

/**
 * Look up a cached result for a deterministic multi-file-scope tool. Returns
 * null on miss. On hit returns the full entry
 * { content, firstToolUseId, ts }.
 */
export function tryScopedToolCached({ sessionId, toolName, args, cwd, countStats = true, touch = true } = {}) {
    if (!sessionId || !toolName) return null;
    const map = _scopedBySession.get(sessionId);
    if (!map) {
        if (countStats) _bumpCounter(sessionId, 'misses');
        return null;
    }
    const key = _scopedKey(toolName, args, cwd);
    const entry = map.get(key);
    if (!entry) {
        if (countStats) _bumpCounter(sessionId, 'misses');
        return null;
    }
    if (touch) {
        map.delete(key);
        map.set(key, entry);
    }
    if (countStats) _bumpCounter(sessionId, 'hits');
    return { content: entry.content, firstToolUseId: entry.firstToolUseId || null, ts: entry.ts };
}

/**
 * Cache a successful tool result. Skip caching empty content (sanity guard).
 * `toolUseId` lets cache hits reference back to the first call that
 * populated the entry so the body need not be re-delivered.
 */
export function setScopedToolCached({ sessionId, toolName, args, cwd, content, toolUseId, complete = true }) {
    if (!sessionId || !toolName) return;
    if (complete === false) return;
    if (typeof content !== 'string' || content.length === 0) return;
    const key = _scopedKey(toolName, args, cwd);
    let map = _scopedBySession.get(sessionId);
    if (!map) { map = new Map(); _scopedBySession.set(sessionId, map); }
    if (map.size >= MAX_PER_SESSION) {
        const firstKey = map.keys().next().value;
        if (firstKey) {
            map.delete(firstKey);
            // Prune evicted key from reverse index entries.
            const ridx = _scopedReverseIdx.get(sessionId);
            if (ridx) {
                for (const [absKey, keySet] of ridx) {
                    keySet.delete(firstKey);
                    if (keySet.size === 0) ridx.delete(absKey);
                }
            }
        }
    }
    const depRoots = _scopedDependencyRoots(toolName, args, cwd);
    map.set(key, { content, ts: Date.now(), firstToolUseId: toolUseId || null, depRoots });
    // Register key in reverse index for dependency roots. Exact root hits use
    // O(1) lookup; touched files under a root are caught by the small prefix scan
    // in clearScopedToolsForSessionPaths (MAX_PER_SESSION is 100).
    let ridx = _scopedReverseIdx.get(sessionId);
    if (!ridx) { ridx = new Map(); _scopedReverseIdx.set(sessionId, ridx); }
    const _registerAbs = (abs) => {
        if (!abs || typeof abs !== 'string') return;
        let s = ridx.get(abs);
        if (!s) { s = new Set(); ridx.set(abs, s); }
        s.add(key);
    };
    for (const dep of depRoots) _registerAbs(dep);
    _bumpCounter(sessionId, 'sets');
}

/**
 * Full clear of the scoped tool cache for one session. Used when touched
 * paths are unknown or a broad mutation may have changed many files.
 */
export function clearScopedToolsForSession(sessionId) {
    if (!sessionId) return;
    _scopedBySession.delete(sessionId);
    _scopedReverseIdx.delete(sessionId);
    _bumpCounter(sessionId, 'clears');
}

/**
 * Targeted scoped-cache invalidation: evict only entries whose cache
 * key is associated with at least one of the given touched paths. Uses a
 * reverse index (absPath → Set<cacheKey>) for exact root hits plus a bounded
 * root-prefix scan for files nested under cached directories/globs. Full wipe
 * when paths cannot be resolved.
 */
export function clearScopedToolsForSessionPaths(sessionId, touchedPaths, cwd) {
    if (!sessionId || !Array.isArray(touchedPaths) || touchedPaths.length === 0) return;
    const map = _scopedBySession.get(sessionId);
    if (!map) return;
    const base = (cwd && typeof cwd === 'string') ? cwd : process.cwd();
    const absPaths = touchedPaths
        .map(p => {
            if (typeof p !== 'string' || p.length === 0) return null;
            try {
                return _normalizeCacheKey(_pathNorm(_pathIsAbs(p) ? p : _pathResolve(base, p)));
            } catch { return null; }
        })
        .filter(Boolean);
    if (absPaths.length === 0) {
        // Fallback: can't resolve — full wipe.
        _scopedBySession.delete(sessionId);
        _scopedReverseIdx.delete(sessionId);
        _bumpCounter(sessionId, 'clears');
        return;
    }
    const ridx = _scopedReverseIdx.get(sessionId);
    const evictedKeys = new Set();
    for (const abs of absPaths) {
        const keys = ridx ? ridx.get(abs) : null;
        if (keys && keys.size > 0) {
            for (const key of keys) {
                if (map.has(key)) {
                    map.delete(key);
                    evictedKeys.add(key);
                }
            }
            keys.clear();
            ridx.delete(abs);
        }
        // Index miss may still touch a cached directory/root dependency
        // (e.g. grep path:"src" then edit src/a.mjs). Prefix scan is bounded
        // by MAX_PER_SESSION and prevents stale scoped cache hits.
        for (const [key, entry] of map) {
            const roots = Array.isArray(entry?.depRoots) ? entry.depRoots : [];
            if (roots.some((root) => _pathTouchesRoot(abs, root))) {
                map.delete(key);
                evictedKeys.add(key);
            }
        }
    }
    // Remove evicted keys from any other reverse-index sets they appeared in; prune empty Sets.
    if (ridx && evictedKeys.size > 0) {
        for (const [absKey, keySet] of ridx) {
            for (const k of evictedKeys) keySet.delete(k);
            if (keySet.size === 0) ridx.delete(absKey);
        }
    }
    if (evictedKeys.size > 0) _bumpCounter(sessionId, 'clears');
}

/** Drop scoped counters for a session on close. */
export function clearScopedCounters(sessionId) {
    if (!sessionId) return;
    _scopedCounters.delete(sessionId);
}

/**
 * Configure the data directory for snapshot writes. Must be called once at
 * startup. Safe to call repeatedly.
 */
function configureCacheStatsSnapshot(dataDir) {
    _snapshotDataDir = typeof dataDir === 'string' && dataDir.length > 0 ? dataDir : null;
}

/**
 * Aggregate all live session counters into totals + per-session breakdown.
 * Pure computation — no I/O. Exported for tests.
 */
function aggregateCacheStats() {
    const totals = { sets: 0, hits: 0, misses: 0, clears: 0 };
    const perSession = [];
    for (const [sessionId, c] of _scopedCounters) {
        totals.sets += c.sets ?? 0;
        totals.hits += c.hits ?? 0;
        totals.misses += c.misses ?? 0;
        totals.clears += c.clears ?? 0;
        perSession.push({
            sessionId,
            sets: c.sets ?? 0,
            hits: c.hits ?? 0,
            misses: c.misses ?? 0,
            clears: c.clears ?? 0,
        });
    }
    return { totals, perSession };
}

function _flushCacheStats() {
    _snapshotTimer = null;
    if (!_snapshotDataDir) return;
    const path = join(_snapshotDataDir, 'cache-stats.json');
    const { totals, perSession } = aggregateCacheStats();
    try {
        writeJsonAtomicSync(path, { writtenAt: Date.now(), totals, perSession }, {
            compact: true,
            lock: true,
            fsync: false,
            fsyncDir: false,
        });
    } catch {
        // best-effort; never throw into caller
    }
}

function _scheduleCacheStatsFlush() {
    if (_snapshotTimer !== null) return;
    // .unref() so the timer doesn't prevent Node exit in tests
    const t = setTimeout(_flushCacheStats, 1000);
    if (typeof t.unref === 'function') t.unref();
    _snapshotTimer = t;
}

/** Sync-flush pending cache-stats snapshot on exit. */
function drainCacheStats() {
    if (_snapshotTimer === null) return;
    clearTimeout(_snapshotTimer);
    _snapshotTimer = null;
    _flushCacheStats();
}
process.on('exit', drainCacheStats);
