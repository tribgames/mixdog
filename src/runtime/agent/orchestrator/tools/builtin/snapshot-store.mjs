import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { writeJsonAtomicSync } from '../../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';

// Mixdog read/write/edit share a scoped snapshot store. Value stores the
// mtime + size at read-time. A missing scope is fail-closed: snapshots without
// a real scope id are NOT recorded under a shared default bucket (would let
// worker A's read satisfy worker B's edit-gate across sessions via a persisted
// __global__.json).
const readFilesByScope = new Map(); // scope → Map(fullPath → { mtimeMs, size, ...meta })

// ── Disk-persisted snapshot store ────────────────────────────────────────
// Mirror the in-memory readFilesByScope to per-scope JSON files under
// `${PLUGIN_DATA}/read-snapshots/`. Hydration is lazy (first scope access);
// flush is debounced and drained synchronously on process exit.
const SNAPSHOT_DIR = (() => {
    try {
        const dataDir = resolvePluginData();
        if (!dataDir) return null;
        const dir = join(dataDir, 'read-snapshots');
        // R4 data-at-rest: snapshot entries reveal which files an actor
        // has read; clamp dir to owner-only on POSIX (advisory on Windows).
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    } catch { return null; }
})();

const SNAPSHOT_STALE_MS = 30 * 24 * 60 * 60 * 1000;
(function sweepStaleSnapshotScopes() {
    if (!SNAPSHOT_DIR) return;
    let entries;
    try { entries = readdirSync(SNAPSHOT_DIR); }
    catch { return; }
    const now = Date.now();
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const full = join(SNAPSHOT_DIR, name);
        try {
            const st = statSync(full);
            if ((now - st.mtimeMs) > SNAPSHOT_STALE_MS) unlinkSync(full);
        } catch { /* missing / race — skip */ }
    }
})();

const PERSIST_DEBOUNCE_MS = 500;
const persistPending = new Map(); // scopeKey → Timeout
const scopeHydrated = new Set();

function snapshotScopeFilePath(scopeKey) {
    if (!SNAPSHOT_DIR) return null;
    const safe = String(scopeKey).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
    return join(SNAPSHOT_DIR, `${safe}.json`);
}

// R3 H1: persisted snapshots are read-back from disk on lazy hydration and
// directly trusted by the edit-gate (`isSnapshotStale` early-returns false
// on stat match). A malformed / forged entry must NEVER reach the gate, so
// every field that downstream code consumes is shape-validated here. Bad
// entries are dropped silently (treated as "never read") rather than
// surfaced — the model will simply be forced to re-read before edit.
const MAX_RANGES_PER_ENTRY = 4096;
function isValidPersistedSnapshotEntry(snap) {
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return false;
    if (!Number.isFinite(snap.mtimeMs)) return false;
    if (!Number.isFinite(snap.size) || snap.size < 0) return false;
    if (snap.ctimeMs !== undefined && !Number.isFinite(snap.ctimeMs)) return false;
    if (snap.contentHash !== undefined && snap.contentHash !== null) {
        if (typeof snap.contentHash !== 'string') return false;
        if (!/^[a-f0-9]{1,128}$/i.test(snap.contentHash)) return false;
    }
    if (snap.ranges !== undefined) {
        if (!Array.isArray(snap.ranges)) return false;
        if (snap.ranges.length > MAX_RANGES_PER_ENTRY) return false;
    }
    if (snap.rangeHashes !== undefined) {
        if (!Array.isArray(snap.rangeHashes)) return false;
        if (snap.rangeHashes.length > MAX_RANGES_PER_ENTRY) return false;
    }
    if (snap.rangeHash !== undefined && snap.rangeHash !== null && typeof snap.rangeHash !== 'string') return false;
    if (snap.grepOnly !== undefined && typeof snap.grepOnly !== 'boolean') return false;
    return true;
}

function loadScopeFromDisk(scopeKey) {
    const path = snapshotScopeFilePath(scopeKey);
    if (!path || !existsSync(path)) return new Map();
    try {
        const raw = readFileSync(path, 'utf-8');
        const obj = _reviveInfinitySentinels(JSON.parse(raw));
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return new Map();
        const map = new Map();
        for (const [fp, snap] of Object.entries(obj)) {
            if (typeof fp !== 'string' || !fp) continue;
            if (!isValidPersistedSnapshotEntry(snap)) continue;
            map.set(fp, snap);
        }
        return map;
    } catch { return new Map(); }
}

// JSON cannot represent Infinity (it serializes to null), which silently turns
// a full-file range { endLine: Infinity } into { endLine: null } on persist and
// breaks the `endLine === Infinity` full-coverage checks after hydrate. Convert
// Infinity to a unique sentinel on write and back on read. Shape-agnostic deep
// clone (does NOT mutate the live in-memory snapshot objects).
const INFINITY_SENTINEL = '__mixdog_Infinity_sentinel__';
function _withInfinitySentinels(value) {
    if (value === Infinity) return INFINITY_SENTINEL;
    if (Array.isArray(value)) return value.map(_withInfinitySentinels);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = _withInfinitySentinels(v);
        return out;
    }
    return value;
}
function _reviveInfinitySentinels(value) {
    if (value === INFINITY_SENTINEL) return Infinity;
    if (Array.isArray(value)) return value.map(_reviveInfinitySentinels);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = _reviveInfinitySentinels(v);
        return out;
    }
    return value;
}

function persistScopeSync(scopeKey) {
    const path = snapshotScopeFilePath(scopeKey);
    if (!path) return;
    const readFiles = readFilesByScope.get(scopeKey);
    if (!readFiles || readFiles.size === 0) {
        // Empty scope: remove on-disk file so it doesn't grow stale.
        try { if (existsSync(path)) unlinkSync(path); } catch {}
        return;
    }
    const obj = {};
    for (const [fp, snap] of readFiles.entries()) obj[fp] = snap;
    try { writeJsonAtomicSync(path, _withInfinitySentinels(obj), { compact: true, lock: true, mode: 0o600 }); } catch {}
}

export function deleteReadSnapshotPathEverywhere(fullPath) {
    for (const [scopeKey, readFiles] of readFilesByScope.entries()) {
        if (readFiles.delete(fullPath)) scheduleScopePersist(scopeKey);
    }
    if (!SNAPSHOT_DIR) return;
    let entries;
    try { entries = readdirSync(SNAPSHOT_DIR); }
    catch { return; }
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const p = join(SNAPSHOT_DIR, name);
        try {
            const obj = JSON.parse(readFileSync(p, 'utf-8'));
            if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, fullPath)) continue;
            delete obj[fullPath];
            if (Object.keys(obj).length === 0) unlinkSync(p);
            else writeJsonAtomicSync(p, obj, { compact: true, lock: true, mode: 0o600 });
        } catch {}
    }
}

export function scheduleScopePersist(scopeKey) {
    if (scopeKey === null || scopeKey === undefined) return;
    if (persistPending.has(scopeKey)) return;
    const t = setTimeout(() => {
        persistPending.delete(scopeKey);
        try { persistScopeSync(scopeKey); } catch {}
    }, PERSIST_DEBOUNCE_MS);
    if (t.unref) t.unref();
    persistPending.set(scopeKey, t);
}

function flushAllScopesSync() {
    for (const [key, timer] of persistPending) {
        try { clearTimeout(timer); } catch {}
        try { persistScopeSync(key); } catch {}
    }
    persistPending.clear();
}
process.on('exit', flushAllScopesSync);

export function readScopeKey(scope) {
    return scope ? String(scope) : null;
}

export function readFilesForScope(scope) {
    const key = readScopeKey(scope);
    if (key === null) {
        // No scope id: fail-closed. Return a fresh ephemeral Map that is
        // never cached in readFilesByScope, never hydrated, never
        // persisted to disk. Writes are dropped on the floor, lookups
        // return undefined → edit-gate cannot pass without a real scoped
        // read. Closes the cross-session bypass via __global__.json.
        return new Map();
    }
    let readFiles = readFilesByScope.get(key);
    if (!readFiles) {
        // Lazy hydrate: pull persisted snapshots for this scope from disk
        // on first access. Subsequent gets stay in-memory.
        readFiles = scopeHydrated.has(key) ? new Map() : loadScopeFromDisk(key);
        scopeHydrated.add(key);
        readFilesByScope.set(key, readFiles);
    }
    return readFiles;
}
