// Per-cwd on-disk code-graph cache: manifest + <hash>.json layout, legacy
// single-file migration, budget pruning, orphan sweep, and a debounced
// atomic flush. Owns its own module-level state (the in-memory disk map,
// manifest, flush timer). Extracted verbatim from code-graph.mjs.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  readdirSync, readFileSync, statSync, existsSync, mkdirSync, renameSync, unlinkSync, openSync, readSync, closeSync,
} from 'node:fs';
import { getPluginData } from '../../config.mjs';
import { writeJsonAtomicSync } from '../../../../shared/atomic-file.mjs';
import {
  canonicalGraphCwd as _canonicalGraphCwd,
  registerCodeGraphDrain,
  drainCodeGraphCache as drainCodeGraphCacheState,
} from '../code-graph-state.mjs';
import {
  CODE_GRAPH_DISK_FILE,
  CODE_GRAPH_DISK_DIR,
  CODE_GRAPH_DISK_MAX_ENTRIES,
  CODE_GRAPH_DISK_MAX_BYTES,
  CODE_GRAPH_FAST_PATH_MAX_BYTES,
  ORPHAN_TMP_MIN_AGE_MS,
  RE_CACHE_TMP,
  RE_MANIFEST_TMP,
  RE_CACHE_LOCK,
} from './constants.mjs';
import { _serializeGraph, _deserializeGraph } from './graph-model.mjs';

const _diskCodeGraphCache = new Map();
let _diskCodeGraphCacheLoaded = false;
let _diskCodeGraphCacheFlushTimer = null;
// Per-cwd manifest read at boot; per-cwd entries load on demand via
// _ensureCwdLoaded(cwd). Avoids the cold-start I/O spike that hit every
// fresh process when the legacy single-file cache grew unbounded.
let _diskManifest = null;

function _codeGraphDiskDir() {
  return join(getPluginData(), CODE_GRAPH_DISK_DIR);
}

const _HASH_CWD_CACHE_MAX = 50;
const _hashCwdCache = new Map();

function _hashCwd(cwd) {
  // Memoize SHA256(canonical cwd) — the same canonical cwd is hashed
  // repeatedly on persist/sweep hot paths. Keyed by canonical cwd; capped
  // so a long-lived process cycling through many cwds can't grow unbounded.
  const canon = _canonicalGraphCwd(cwd);
  const cached = _hashCwdCache.get(canon);
  if (cached !== undefined) return cached;
  const hash = createHash('sha256').update(canon).digest('hex').slice(0, 16);
  if (_hashCwdCache.size >= _HASH_CWD_CACHE_MAX) {
    // Evict oldest insertion (Map preserves insertion order).
    _hashCwdCache.delete(_hashCwdCache.keys().next().value);
  }
  _hashCwdCache.set(canon, hash);
  return hash;
}

function _migrateLegacyDiskCache() {
  const legacy = join(getPluginData(), CODE_GRAPH_DISK_FILE);
  if (!existsSync(legacy)) return;
  try {
    const parsed = JSON.parse(readFileSync(legacy, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [cwd, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== 'object') continue;
        _diskCodeGraphCache.set(_canonicalGraphCwd(cwd), entry);
      }
    }
    // Rename rather than delete so a rollback can recover the blob if the
    // per-cwd layout misbehaves. Next persist round writes the new layout
    // and the legacy path no longer exists, so this branch is a one-shot.
    renameSync(legacy, `${legacy}.bak-${Date.now()}`);
    // Schedule an immediate flush so the in-memory entries we just loaded
    // get written out as per-cwd files now, instead of waiting for the
    // next graph rebuild to trigger _setDiskCodeGraphEntry. Without this,
    // the layout transition is half-complete (legacy renamed, new layout
    // empty) until an unrelated build happens to land.
    _scheduleDiskCodeGraphCacheFlush();
  } catch (err) {
    process.stderr.write(`[code-graph] legacy cache migration failed: ${err?.message || err}\n`);
  }
}

// This intentionally does not call _loadDiskCodeGraphCache: the parent-side
// fast path uses it to leave a legacy blob's synchronous read/JSON.parse to
// the Worker, where normal one-shot migration still happens.
export function hasLegacyDiskCodeGraphCache() {
  return existsSync(join(getPluginData(), CODE_GRAPH_DISK_FILE));
}

function _pruneDiskCodeGraphEntries(_now = Date.now()) {
  for (const [cwd, entry] of _diskCodeGraphCache) {
    if (!entry || typeof entry !== 'object') {
      _diskCodeGraphCache.delete(cwd);
      continue;
    }
    // Disk entries are not TTL-evicted: signature validation on load/build
    // plus _pruneCodeGraphManifestForBudget (MIXDOG_CODE_GRAPH_CACHE_MAX_MB)
    // govern freshness and size. Memory cache keeps CODE_GRAPH_TTL_MS.
  }
  while (_diskCodeGraphCache.size > CODE_GRAPH_DISK_MAX_ENTRIES) {
    const oldest = _diskCodeGraphCache.keys().next().value;
    if (!oldest) break;
    _diskCodeGraphCache.delete(oldest);
  }
}

function _isCodeGraphCacheHash(value) {
  return /^[0-9a-f]{8,64}$/i.test(String(value || ''));
}

export function _pruneCodeGraphManifestForBudget(manifest, dir, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(0, Math.floor(options.maxEntries))
    : CODE_GRAPH_DISK_MAX_ENTRIES;
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(0, Math.floor(options.maxBytes))
    : CODE_GRAPH_DISK_MAX_BYTES;
  const rows = [];
  for (const [cwd, meta] of Object.entries(manifest || {})) {
    const hash = String(meta?.hash || '');
    if (!cwd || !_isCodeGraphCacheHash(hash)) continue;
    const file = join(dir, `${hash}.json`);
    let size = 0;
    try { size = statSync(file).size; } catch { continue; }
    rows.push({
      cwd,
      hash,
      builtAt: Number(meta?.builtAt) || 0,
      size: Math.max(0, Number(size) || 0),
    });
  }
  rows.sort((a, b) => (a.builtAt - b.builtAt) || a.cwd.localeCompare(b.cwd));
  const keep = new Set(rows.map((row) => row.cwd));
  let totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
  const evicted = [];

  const evict = (row, reason) => {
    if (!row || !keep.has(row.cwd)) return false;
    keep.delete(row.cwd);
    totalBytes -= row.size;
    evicted.push({ ...row, reason });
    return true;
  };

  for (const row of rows) {
    if (keep.size <= maxEntries) break;
    evict(row, 'max-entries');
  }
  for (const row of rows) {
    if (totalBytes <= maxBytes) break;
    evict(row, 'max-bytes');
  }

  const pruned = {};
  for (const row of rows) {
    if (!keep.has(row.cwd)) continue;
    pruned[row.cwd] = { hash: row.hash, builtAt: row.builtAt };
  }
  return { manifest: pruned, evicted, totalBytes: Math.max(0, totalBytes) };
}

function _readCacheLockOwnerPid(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const tok = String(raw).trim().split(/\s+/)[0];
    const pid = Number.parseInt(tok, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function _cacheLockOwnerIsDead(lockPath) {
  const pid = _readCacheLockOwnerPid(lockPath);
  // Unparseable/unreadable owner pid: keep the lock (conservative). Truly stale
  // locks are reclaimed on the next writeJsonAtomicSync via atomic-file.mjs
  // stale-lock recovery (mtime > staleMs, dead owner pid).
  if (pid === null) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

function _cacheFileOlderThanGuard(fullPath, now, minAgeMs) {
  try {
    const st = statSync(fullPath);
    return now - st.mtimeMs > minAgeMs;
  } catch {
    return false;
  }
}

// Best-effort orphan cleanup: evicted <hash>.json plus aged atomic-write .tmp/.lock
// left by crash/kill between temp write and rename (writeFileAtomicSync). Young temps
// are kept because a live persist may still hold the matching .lock while writing.
function _sweepCodeGraphCacheDir(dir, validHashes, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const sweepJson = opts.sweepJson !== false;
  try {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (f === 'manifest.json') continue;
      if (f.endsWith('.json')) {
        if (!sweepJson) continue;
        const hash = f.slice(0, -5);
        if (!validHashes.has(hash)) {
          try { unlinkSync(full); } catch { /* best-effort */ }
        }
        continue;
      }
      if (RE_CACHE_TMP.test(f) || RE_MANIFEST_TMP.test(f)) {
        if (!_cacheFileOlderThanGuard(full, now, ORPHAN_TMP_MIN_AGE_MS)) continue;
        try { unlinkSync(full); } catch { /* best-effort */ }
        continue;
      }
      if (f === 'manifest.json.lock' || RE_CACHE_LOCK.test(f)) {
        if (!_cacheFileOlderThanGuard(full, now, ORPHAN_TMP_MIN_AGE_MS)) continue;
        if (!_cacheLockOwnerIsDead(full)) continue;
        try { unlinkSync(full); } catch { /* best-effort */ }
      }
    }
  } catch { /* sweep best-effort */ }
}

function _loadDiskCodeGraphCache(now = Date.now()) {
  if (_diskCodeGraphCacheLoaded) return;
  _diskCodeGraphCacheLoaded = true;

  // One-shot migration from the legacy single-file cache. Subsequent boots
  // skip this branch because the source file was renamed to .bak.
  _migrateLegacyDiskCache();

  // Manifest-only load: per-cwd entries are picked up by _ensureCwdLoaded()
  // at lookup time. Cold start now pays a single small JSON.parse instead
  // of reading every per-cwd file (~24 × ~2 MB on long-running workspaces).
  let manifestTrusted = false;
  try {
    const manifestFile = join(_codeGraphDiskDir(), 'manifest.json');
    if (existsSync(manifestFile)) {
      const parsed = JSON.parse(readFileSync(manifestFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        _diskManifest = parsed;
        manifestTrusted = true;
      }
    }
  } catch (err) {
    process.stderr.write(`[code-graph] disk manifest load failed: ${err?.message || err}\n`);
  }
  if (!_diskManifest) _diskManifest = {};
  _pruneDiskCodeGraphEntries(now);
  try {
    const dir = _codeGraphDiskDir();
    mkdirSync(dir, { recursive: true });
    const validHashes = new Set();
    for (const meta of Object.values(_diskManifest)) {
      if (meta && typeof meta === 'object' && meta.hash) validHashes.add(meta.hash);
    }
    // Without a successfully loaded manifest we must not delete <hash>.json
    // files (validHashes would be empty or incomplete after a parse failure).
    _sweepCodeGraphCacheDir(dir, validHashes, { now, sweepJson: manifestTrusted });
  } catch { /* boot sweep best-effort */ }
}

// Demand-load one cwd's per-file entry. Callers invoke this right before
// reading the disk cache so the in-memory cache stays populated only for
// cwds actually looked up in this process lifetime.
function _ensureCwdLoaded(cwd) {
  const key = _canonicalGraphCwd(cwd);
  if (_diskCodeGraphCache.has(key)) return;
  if (!_diskManifest) return;
  const meta = _diskManifest[key];
  if (!meta || typeof meta !== 'object' || !meta.hash) return;
  try {
    const file = join(_codeGraphDiskDir(), `${meta.hash}.json`);
    if (!existsSync(file)) return;
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    if (entry && typeof entry === 'object') _diskCodeGraphCache.set(key, entry);
  } catch { /* skip corrupt per-cwd file */ }
}

export function _persistDiskCodeGraphCacheNow({
  strict = false,
  writeJson = writeJsonAtomicSync,
} = {}) {
  try {
    _loadDiskCodeGraphCache();
    _pruneDiskCodeGraphEntries();
    const dir = _codeGraphDiskDir();
    mkdirSync(dir, { recursive: true });

    // Read the on-disk manifest BEFORE writing so cwd entries owned by
    // other instances (MIXDOG_MULTI_INSTANCE=1) survive. Without this,
    // our orphan sweep below would happily unlink another instance's
    // per-cwd files just because we don't have them in our in-memory map.
    let preserved = {};
    try {
      const raw = readFileSync(join(dir, 'manifest.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') preserved = parsed;
    } catch { /* no existing manifest yet */ }

    let manifest = { ...preserved };
    const validHashes = new Set();
    for (const [cwd, entry] of _diskCodeGraphCache) {
      const hash = _hashCwd(cwd);
      const file = join(dir, `${hash}.json`);
      // Try-once (timeoutMs:0): the debounced flush runs on the lead/TUI main
      // process (codeGraph tool + prewarm). withFileLockSync's Atomics.wait
      // would freeze the renderer on cross-process cache contention. Cache is
      // rebuildable — a busy lock just skips this flush; _scheduleDiskCodeGraphCacheFlush
      // re-schedules on the next build. Exit drain still runs (unref'd timer
      // cancelled + direct call).
      writeJson(file, entry, { compact: true, lock: true, timeoutMs: 0 });
      let bytes = null;
      try { bytes = statSync(file).size; } catch { /* written entry may be unavailable */ }
      manifest[cwd] = {
        hash,
        builtAt: entry.builtAt || Date.now(),
        bytes: Number.isFinite(bytes) ? bytes : undefined,
        maxFiles: Number.isFinite(entry.maxFiles) ? entry.maxFiles : undefined,
      };
    }
    const pruned = _pruneCodeGraphManifestForBudget(manifest, dir);
    manifest = pruned.manifest;
    for (const row of pruned.evicted) {
      _diskCodeGraphCache.delete(row.cwd);
    }
    for (const meta of Object.values(manifest)) {
      if (meta && typeof meta === 'object' && meta.hash) validHashes.add(meta.hash);
    }

    const manifestFile = join(dir, 'manifest.json');
    writeJson(manifestFile, manifest, { compact: true, lock: true, timeoutMs: 0 });
    _diskManifest = manifest;

    // Sweep orphan per-cwd files. validHashes now includes every hash in
    // the merged manifest (preserved + ours) so cross-instance cache files
    // are never collateral damage.
    _sweepCodeGraphCacheDir(dir, validHashes, { sweepJson: true });
  } catch (err) {
    process.stderr.write(`[code-graph] disk cache persist failed (target: ${_codeGraphDiskDir()}): ${err?.message || err}\n`);
    if (strict) throw err;
  }
}

function _scheduleDiskCodeGraphCacheFlush() {
  if (_diskCodeGraphCacheFlushTimer) return;
  _diskCodeGraphCacheFlushTimer = setTimeout(() => {
    _diskCodeGraphCacheFlushTimer = null;
    _persistDiskCodeGraphCacheNow();
  }, 250);
  if (typeof _diskCodeGraphCacheFlushTimer.unref === 'function') _diskCodeGraphCacheFlushTimer.unref();
}

/**
 * Sync-flush any pending code-graph disk cache write before process exit.
 * Cancels the 250ms scheduled-flush timer and runs _persistDiskCodeGraphCacheNow
 * directly so newly-built graphs land on disk regardless of exit timing.
 */
function drainCodeGraphCacheNow() {
  if (_diskCodeGraphCacheFlushTimer) {
    clearTimeout(_diskCodeGraphCacheFlushTimer);
    _diskCodeGraphCacheFlushTimer = null;
    _persistDiskCodeGraphCacheNow();
  }
}
registerCodeGraphDrain(drainCodeGraphCacheNow);

// Worker-only success fencing: unlike the exit/parent drain, a failed
// persistence must reject the Worker result instead of being log-only.
export function drainCodeGraphCacheStrict() {
  if (_diskCodeGraphCacheFlushTimer) {
    clearTimeout(_diskCodeGraphCacheFlushTimer);
    _diskCodeGraphCacheFlushTimer = null;
  }
  _persistDiskCodeGraphCacheNow({ strict: true });
}

// Public: delegate to the state module's drain hook (which invokes the
// registered drainCodeGraphCacheNow). Preserves the original facade behavior.
export function drainCodeGraphCache() {
  drainCodeGraphCacheState();
}

// Read a demand-loaded disk entry for `cwd` (loads it first). Returns the
// serialized payload or undefined. Callers deserialize via graph-model.
export function getDiskCodeGraphEntry(cwd) {
  const key = _canonicalGraphCwd(cwd);
  _ensureCwdLoaded(key);
  return _diskCodeGraphCache.get(key);
}

// Inspect only manifest metadata (or a stat fallback), never parse the entry.
// The main-thread fast path uses this to leave large/legacy entries to Worker
// isolation while still allowing small compatible entries to avoid Worker boot.
export function probeDiskCodeGraphEntry(cwd, maxBytes = CODE_GRAPH_FAST_PATH_MAX_BYTES) {
  const key = _canonicalGraphCwd(cwd);
  const meta = _diskManifest?.[key];
  if (!meta || typeof meta !== 'object' || !_isCodeGraphCacheHash(meta.hash)) return null;
  const file = join(_codeGraphDiskDir(), `${meta.hash}.json`);
  let bytes = Number(meta.bytes);
  if (!Number.isFinite(bytes) || bytes < 0) {
    try { bytes = statSync(file).size; } catch { return null; }
  }
  let maxFiles = Number.isFinite(meta.maxFiles) ? meta.maxFiles : null;
  // Legacy manifests have no per-entry metadata. Read only the compact JSON
  // header (maxFiles precedes nodes) rather than parsing a potentially huge
  // payload on the main thread.
  if (maxFiles === null) {
    let fd = null;
    try {
      fd = openSync(file, 'r');
      const header = Buffer.allocUnsafe(4096);
      const read = readSync(fd, header, 0, header.length, 0);
      const match = /"maxFiles":(\d+)/.exec(header.toString('utf8', 0, read));
      if (match) maxFiles = Number(match[1]);
    } catch { /* leave legacy/corrupt metadata in the Worker path */ }
    finally { if (fd !== null) try { closeSync(fd); } catch {} }
  }
  return {
    bytes,
    maxFiles,
    isFastPathEligible: bytes <= maxBytes,
  };
}

// Ensure the on-disk manifest/sweep boot pass has run (idempotent).
export function ensureDiskCodeGraphLoaded(now = Date.now()) {
  _loadDiskCodeGraphCache(now);
}

// Read-only inventory used by filesystem-root federation. This deliberately
// does not initialize, migrate, prune, or load graph payloads: manifest keys
// are sufficient to identify roots the user has already indexed.
export function listCachedCodeGraphRoots() {
  try {
    const file = join(_codeGraphDiskDir(), 'manifest.json');
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
  } catch {
    return [];
  }
}

export function _setDiskCodeGraphEntry(cwd, graph) {
  _loadDiskCodeGraphCache();
  // Stamp the cache entry with the persistence timestamp (not the build
  // start) so manifest/signature metadata stays fresh. Disk retention is
  // governed by signature validation and MIXDOG_CODE_GRAPH_CACHE_MAX_MB,
  // not CODE_GRAPH_TTL_MS (memory cache only).
  const serialized = _serializeGraph(graph);
  serialized.builtAt = Date.now();
  _diskCodeGraphCache.set(_canonicalGraphCwd(cwd), serialized);
  _pruneDiskCodeGraphEntries();
  _scheduleDiskCodeGraphCacheFlush();
}
