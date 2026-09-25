// Per-cwd on-disk code-graph cache: manifest + <hash>.json layout, stray
// single-file cleanup, budget pruning, orphan sweep, and a debounced
// atomic flush. Owns its own module-level state (the in-memory disk map,
// manifest, flush timer).

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { getPluginData } from '../../config.mjs';
import { writeJsonAtomicSync, withFileLockSync } from '../../../../shared/atomic-file.mjs';
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
  CODE_GRAPH_DISK_MEMORY_MAX_BYTES,
  CODE_GRAPH_FAST_PATH_MAX_BYTES,
  ORPHAN_TMP_MIN_AGE_MS,
  RE_CACHE_TMP,
  RE_MANIFEST_TMP,
  RE_CACHE_LOCK,
  RE_CALLS_CACHE_TMP,
  RE_CALLS_CACHE_LOCK,
} from './constants.mjs';
import { _serializeGraph } from './graph-model.mjs';
import {
  callsSidecarPath,
  callsSidecarHash,
  buildCallsSidecarPayload,
  graphHasCallsToPersist,
  readCallsSidecarPayload,
  applyCallsSidecarToGraph,
} from './calls-cache.mjs';

const _diskCodeGraphCache = new Map();
// Call-site sidecars waiting for the next persist, keyed by canonical cwd.
// Dropped once written: the file is the durable copy, and a graph that needs
// them again reads it through hydrateGraphCallsFromSidecar().
const _pendingCallsSidecars = new Map();
// Approximate serialized bytes of each resident entry, taken from the same
// numbers the manifest already records (statSync on persist, the read length
// on demand-load). Backs the resident-memory budget in the prune below.
const _diskCodeGraphBytes = new Map();
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

// The pre-layout single-file cache blob is dead weight: caches are fully
// regenerable, so remove the stray file instead of migrating its contents.
function _cleanupLegacyDiskCache() {
  const stale = join(getPluginData(), CODE_GRAPH_DISK_FILE);
  if (!existsSync(stale)) return;
  try {
    unlinkSync(stale);
  } catch {
    /* best-effort */
  }
}

function _dropDiskEntry(cwd) {
  _diskCodeGraphCache.delete(cwd);
  _diskCodeGraphBytes.delete(cwd);
}

function _noteDiskEntryBytes(cwd, bytes) {
  if (Number.isFinite(bytes) && bytes >= 0) _diskCodeGraphBytes.set(cwd, bytes);
}

function _residentDiskBytes() {
  let total = 0;
  for (const cwd of _diskCodeGraphCache.keys()) total += _diskCodeGraphBytes.get(cwd) || 0;
  return total;
}

function _pruneDiskCodeGraphEntries(_now = Date.now()) {
  for (const [cwd, entry] of _diskCodeGraphCache) {
    if (!entry || typeof entry !== 'object') {
      _dropDiskEntry(cwd);
    }
    // Disk entries are not TTL-evicted: signature validation on load/build
    // plus _pruneCodeGraphManifestForBudget (MIXDOG_CODE_GRAPH_CACHE_MAX_MB)
    // govern freshness and size. Memory cache keeps CODE_GRAPH_TTL_MS.
  }
  while (_diskCodeGraphCache.size > CODE_GRAPH_DISK_MAX_ENTRIES) {
    const oldest = _diskCodeGraphCache.keys().next().value;
    if (!oldest) break;
    _dropDiskEntry(oldest);
  }
  // Resident-memory budget, oldest first. The newest entry is never evicted:
  // it is the root the caller is working in right now, so dropping it would
  // force a re-read on the very next lookup. Evicted entries stay on disk and
  // return through _ensureCwdLoaded().
  while (_diskCodeGraphCache.size > 1 && _residentDiskBytes() > CODE_GRAPH_DISK_MEMORY_MAX_BYTES) {
    const oldest = _diskCodeGraphCache.keys().next().value;
    if (!oldest) break;
    _dropDiskEntry(oldest);
  }
}

function _isCodeGraphCacheHash(value) {
  return /^[0-9a-f]{8,64}$/i.test(String(value || ''));
}

// Every entry hash a manifest references — the files the orphan sweep keeps.
function _manifestHashes(manifest) {
  const hashes = new Set();
  for (const meta of Object.values(manifest)) {
    if (meta && typeof meta === 'object' && meta.hash) hashes.add(meta.hash);
  }
  return hashes;
}

// Every cached root with its on-disk footprint, oldest build first. Roots
// whose cache file is gone are skipped. The call-site sidecar is part of a
// root's footprint, so the byte budget sees it even though no mode parses it
// eagerly.
function manifestFootprintRows(manifest, dir) {
  const rows = [];
  for (const [cwd, meta] of Object.entries(manifest || {})) {
    const hash = String(meta?.hash || '');
    if (!cwd || !_isCodeGraphCacheHash(hash)) continue;
    let size = 0;
    try {
      size = statSync(join(dir, `${hash}.json`)).size;
    } catch {
      continue;
    }
    let sidecarSize = 0;
    try {
      sidecarSize = statSync(callsSidecarPath(dir, hash)).size;
    } catch {
      /* no sidecar */
    }
    rows.push({
      cwd,
      hash,
      builtAt: Number(meta?.builtAt) || 0,
      size: Math.max(0, Number(size) || 0) + Math.max(0, Number(sidecarSize) || 0),
    });
  }
  rows.sort((a, b) => a.builtAt - b.builtAt || a.cwd.localeCompare(b.cwd));
  return rows;
}

export function _pruneCodeGraphManifestForBudget(manifest, dir, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(0, Math.floor(options.maxEntries))
    : CODE_GRAPH_DISK_MAX_ENTRIES;
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(0, Math.floor(options.maxBytes))
    : CODE_GRAPH_DISK_MAX_BYTES;
  const rows = manifestFootprintRows(manifest, dir);
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
        // `<hash>.calls.json` belongs to `<hash>`: it lives and dies with the
        // main entry instead of looking like an orphan of its own.
        const hash = callsSidecarHash(f) ?? f.slice(0, -5);
        if (!validHashes.has(hash)) {
          try {
            unlinkSync(full);
          } catch {
            /* best-effort */
          }
        }
        continue;
      }
      if (RE_CACHE_TMP.test(f) || RE_MANIFEST_TMP.test(f) || RE_CALLS_CACHE_TMP.test(f)) {
        if (!_cacheFileOlderThanGuard(full, now, ORPHAN_TMP_MIN_AGE_MS)) continue;
        try {
          unlinkSync(full);
        } catch {
          /* best-effort */
        }
        continue;
      }
      if (f === 'manifest.json.lock' || RE_CACHE_LOCK.test(f) || RE_CALLS_CACHE_LOCK.test(f)) {
        if (!_cacheFileOlderThanGuard(full, now, ORPHAN_TMP_MIN_AGE_MS)) continue;
        if (!_cacheLockOwnerIsDead(full)) continue;
        try {
          unlinkSync(full);
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* sweep best-effort */
  }
}

function _loadDiskCodeGraphCache(now = Date.now()) {
  if (_diskCodeGraphCacheLoaded) return;
  _diskCodeGraphCacheLoaded = true;

  _cleanupLegacyDiskCache();

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
    // Without a successfully loaded manifest we must not delete <hash>.json
    // files (the hash set would be empty or incomplete after a parse failure).
    _sweepCodeGraphCacheDir(dir, _manifestHashes(_diskManifest), { now, sweepJson: manifestTrusted });
  } catch {
    /* boot sweep best-effort */
  }
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
    const raw = readFileSync(file, 'utf8');
    const entry = JSON.parse(raw);
    if (entry && typeof entry === 'object') {
      _diskCodeGraphCache.set(key, entry);
      _noteDiskEntryBytes(key, raw.length);
      _pruneDiskCodeGraphEntries();
    }
  } catch {
    /* skip corrupt per-cwd file */
  }
}

// Read under the common lock so concurrently completed roots cannot
// overwrite one another with manifests based on the same stale snapshot.
function _readPreservedManifest(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* no existing manifest yet */
  }
  return {};
}

function _fileSizeOrNull(file) {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

// Writes one cwd's graph entry (and its pending call-site sidecar) and answers
// with its manifest row. The sidecar is written in the same critical section
// as the entry it belongs to, so a reader never sees calls from one build
// paired with the graph of another. An absent pending payload keeps the
// existing file: this build simply had nothing new to say.
function _persistDiskEntry(dir, cwd, entry, preserved, writeJson) {
  const hash = _hashCwd(cwd);
  const file = join(dir, `${hash}.json`);
  writeJson(file, entry, { compact: true, lock: false });
  const bytes = _fileSizeOrNull(file);
  _noteDiskEntryBytes(cwd, bytes);
  let callsBytes = Number(preserved?.[cwd]?.callsBytes);
  const sidecar = _pendingCallsSidecars.get(cwd);
  if (sidecar) {
    const sidecarFile = callsSidecarPath(dir, hash);
    writeJson(sidecarFile, sidecar, { compact: true, lock: false });
    _pendingCallsSidecars.delete(cwd);
    callsBytes = _fileSizeOrNull(sidecarFile) ?? undefined;
  }
  return {
    hash,
    builtAt: entry.builtAt || Date.now(),
    bytes: Number.isFinite(bytes) ? bytes : undefined,
    callsBytes: Number.isFinite(callsBytes) ? callsBytes : undefined,
    maxFiles: Number.isFinite(entry.maxFiles) ? entry.maxFiles : undefined,
  };
}

function _commitDiskCodeGraphCache(dir, writeJson) {
  _loadDiskCodeGraphCache();
  _pruneDiskCodeGraphEntries();
  const preserved = _readPreservedManifest(dir);
  let manifest = { ...preserved };
  for (const [cwd, entry] of _diskCodeGraphCache) {
    manifest[cwd] = _persistDiskEntry(dir, cwd, entry, preserved, writeJson);
  }
  const pruned = _pruneCodeGraphManifestForBudget(manifest, dir);
  manifest = pruned.manifest;
  for (const row of pruned.evicted) {
    _dropDiskEntry(row.cwd);
  }
  writeJson(join(dir, 'manifest.json'), manifest, { compact: true, lock: false });
  _diskManifest = manifest;
  // Sweep orphan per-cwd files. The kept set includes every hash in the
  // merged manifest (preserved + ours) so cross-instance cache files are
  // never collateral damage.
  _sweepCodeGraphCacheDir(dir, _manifestHashes(manifest), { sweepJson: true });
}

function _persistDiskCodeGraphCacheNow({ strict = false, writeJson = writeJsonAtomicSync } = {}) {
  try {
    const dir = _codeGraphDiskDir();
    mkdirSync(dir, { recursive: true });
    // Graph BUILD work remains fully parallel. Only the short disk COMMIT is
    // serialized across workers/processes so each writer re-reads and merges
    // the latest manifest while holding one common lock. Per-file/manifest
    // atomic writers run lock:false inside this outer critical section.
    //
    // Main/TUI debounced writes stay try-once (never Atomics.wait on the event
    // loop). Worker strict drains may wait because they run off-thread and must
    // not fail a successful graph build merely because a sibling root finished
    // at the same instant.
    withFileLockSync(join(dir, '.persist.lock'), () => _commitDiskCodeGraphCache(dir, writeJson), {
      timeoutMs: strict ? 30_000 : 0,
    });
  } catch (err) {
    process.stderr.write(
      `[code-graph] disk cache persist failed (target: ${_codeGraphDiskDir()}): ${err?.message || err}\n`
    );
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
  const entry = _diskCodeGraphCache.get(key);
  // Re-insert so the resident-byte prune evicts by RECENCY. Map.set does not
  // move an existing key, so without this the first root ever touched stays
  // "oldest" forever and gets evicted while it is the one being worked in.
  if (entry !== undefined) {
    _diskCodeGraphCache.delete(key);
    _diskCodeGraphCache.set(key, entry);
  }
  return entry;
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
    try {
      bytes = statSync(file).size;
    } catch {
      return null;
    }
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
    } catch {
      /* leave legacy/corrupt metadata in the Worker path */
    } finally {
      if (fd !== null)
        try {
          closeSync(fd);
        } catch {}
    }
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

// ── call-site sidecar ───────────────────────────────────────────────────────
// Resolve the sidecar file of a canonical cwd. The manifest hash wins when the
// entry is known (it is what the persist loop wrote); otherwise the hash is
// derived the same way the writer would.
function _callsSidecarFileFor(key) {
  const meta = _diskManifest?.[key];
  const hash = meta && _isCodeGraphCacheHash(meta.hash) ? meta.hash : _hashCwd(key);
  return callsSidecarPath(_codeGraphDiskDir(), hash);
}

// Stage the sidecar for the next persist (full build AND `--files`
// incremental, both of which end in _setDiskCodeGraphEntry). A build that
// contributes no call data leaves the existing sidecar alone, so a run with an
// older binary cannot wipe call sites a newer one produced.
function _stageCallsSidecar(key, graph) {
  try {
    if (!graphHasCallsToPersist(graph)) return;
    const previous = _pendingCallsSidecars.get(key) || readCallsSidecarPayload(_callsSidecarFileFor(key));
    const { payload } = buildCallsSidecarPayload(graph, previous);
    _pendingCallsSidecars.set(key, payload);
  } catch (err) {
    process.stderr.write(`[code-graph] calls sidecar staging failed: ${err?.message || err}\n`);
  }
}

/**
 * Fill a cache-loaded graph's nodes with their persisted AST call sites.
 * Called by the callers/callees/references modes only — the first such query
 * of a process pays one sidecar read, every other mode pays nothing. Runs at
 * most once per graph object (the marker is cleared even on a miss, so a
 * missing/corrupt sidecar cannot be re-read on every query).
 * Returns the number of files hydrated.
 */
export function hydrateGraphCallsFromSidecar(graph) {
  if (graph?._callsHydration !== 'pending') return 0;
  graph._callsHydration = 'done';
  try {
    _loadDiskCodeGraphCache();
    const key = _canonicalGraphCwd(graph.cwd);
    const payload = _pendingCallsSidecars.get(key) || readCallsSidecarPayload(_callsSidecarFileFor(key));
    if (!payload) return 0; // old cache without a sidecar → calls stay null
    return applyCallsSidecarToGraph(graph, payload);
  } catch {
    return 0;
  }
}

export function _setDiskCodeGraphEntry(cwd, graph, { persist = true } = {}) {
  _loadDiskCodeGraphCache();
  // Stamp the cache entry with the persistence timestamp (not the build
  // start) so manifest/signature metadata stays fresh. Disk retention is
  // governed by signature validation and MIXDOG_CODE_GRAPH_CACHE_MAX_MB,
  // not CODE_GRAPH_TTL_MS (memory cache only).
  const serialized = _serializeGraph(graph);
  serialized.builtAt = Date.now();
  const key = _canonicalGraphCwd(cwd);
  // delete-then-set makes this the newest entry for the recency prune below.
  _diskCodeGraphCache.delete(key);
  _diskCodeGraphCache.set(key, serialized);
  // persist:false is the "adopt what another process already wrote" path (the
  // Worker fenced its own sidecar write): staging here would re-read and
  // re-serialize the whole sidecar for a flush that never happens.
  if (persist) _stageCallsSidecar(key, graph);
  // The rebuilt graph of a root is close in size to its last persisted form;
  // the next flush replaces this with the exact statSync figure.
  _noteDiskEntryBytes(key, Number(_diskManifest?.[key]?.bytes));
  _pruneDiskCodeGraphEntries();
  // Worker success is already fenced by drainCodeGraphCacheStrict(); the
  // parent only adopts that result. Rewriting it here races a following
  // Worker on manifest.json.lock without adding durability.
  if (persist) _scheduleDiskCodeGraphCacheFlush();
}
