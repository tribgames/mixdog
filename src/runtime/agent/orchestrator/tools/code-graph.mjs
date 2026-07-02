import { createHash } from 'node:crypto';
import { resolve as pathResolve, isAbsolute, dirname, relative as pathRelative, join } from 'node:path';
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  normalizeInputPath,
  toDisplayPath,
} from './builtin.mjs';
import { getPluginData } from '../config.mjs';
import { ensureGraphBinary, findCachedGraphBinary } from './graph-binary-fetcher.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { CODE_GRAPH_TOOL_DEFS } from './code-graph-tool-defs.mjs';
import { findFileByBasename } from './builtin/path-diagnostics.mjs';
import { acquire as acquireChildSpawnSlot } from '../../../shared/child-spawn-gate.mjs';
import { markScopedCacheIncomplete } from '../session/cache/scoped-cache-outcome.mjs';
import {
  canonicalGraphCwd as _canonicalGraphCwd,
  codeGraphCache as _codeGraphCache,
  consumeCodeGraphDirtyPaths as _consumeCodeGraphDirtyPaths,
  drainCodeGraphCache as drainCodeGraphCacheState,
  getCodeGraphGen as _getCodeGraphGen,
  registerCodeGraphDrain,
} from './code-graph-state.mjs';
export { markCodeGraphDirtyPaths } from './code-graph-state.mjs';

const CODE_GRAPH_TTL_MS = 30_000;
const CODE_GRAPH_MAX_FILES = 10_000;
const CODE_GRAPH_WORKER_TIMEOUT_MS = 120_000;
// Timeout for the native mixdog-graph binary child process (spawned per graph build).
const CODE_GRAPH_BINARY_TIMEOUT_MS = Math.max(1000, Number(process.env.MIXDOG_CODE_GRAPH_BINARY_TIMEOUT_MS) || 20000);
// Legacy single-file cache. Kept as a constant for the one-shot migration
// path; new writes go into the per-cwd directory layout below.
const CODE_GRAPH_DISK_FILE = 'code-graph-cache.json';
// Per-cwd cache: <data>/code-graph-cache/manifest.json + <hash>.json per
// indexed root. Avoids the unbounded single-file blob (observed >50 MB on
// long-running workspaces) that had to be JSON.parsed in full on every
// fresh process startup.
const CODE_GRAPH_DISK_DIR = 'code-graph-cache';
const CODE_GRAPH_DISK_MAX_ENTRIES = 24;
const CODE_GRAPH_DISK_MAX_BYTES = Math.max(
  1 * 1024 * 1024,
  Math.floor((Number(process.env.MIXDOG_CODE_GRAPH_CACHE_MAX_MB) || 80) * 1024 * 1024),
);
// Reap writeFileAtomicSync debris only after this age (see _sweepCodeGraphCacheDir).
// Younger .tmp files may belong to an in-flight persist still holding the sibling .lock;
// DEFAULT_LOCK_TIMEOUT_MS is 8s — 120s is a safe margin for large graph JSON writes.
const ORPHAN_TMP_MIN_AGE_MS = 120_000;
const RE_CACHE_TMP = /^\.[0-9a-f]{16}\.json\.[0-9a-f]{24}\.tmp$/i;
const RE_MANIFEST_TMP = /^\.manifest\.json\.[0-9a-f]{24}\.tmp$/i;
const RE_CACHE_LOCK = /^[0-9a-f]{16}\.json\.lock$/i;
const CODE_GRAPH_MEMORY_MAX_ENTRIES = Math.max(
  1,
  Math.floor(Number(process.env.MIXDOG_CODE_GRAPH_MEMORY_MAX_ENTRIES) || 6),
);
const CODE_GRAPH_MEMORY_MAX_SOURCE_BYTES = Math.max(
  1 * 1024 * 1024,
  Math.floor((Number(process.env.MIXDOG_CODE_GRAPH_MEMORY_MAX_MB) || 48) * 1024 * 1024),
);
const _diskCodeGraphCache = new Map();
let _diskCodeGraphCacheLoaded = false;
let _diskCodeGraphCacheFlushTimer = null;
// Per-cwd manifest read at boot; per-cwd entries load on demand via
// _ensureCwdLoaded(cwd). Avoids the cold-start I/O spike that hit every
// fresh process when the legacy single-file cache grew unbounded.
let _diskManifest = null;
// In-flight async builds keyed by canonical graphCwd. Same-cwd parallel
// callers (prewarm + cache-miss + multiple find_symbol) share one Worker
// spawn instead of fanning out. Entry removed on settle so the next caller
// after a failure can retry.
const _inflightAsyncBuilds = new Map();
function _codeGraphDiskDir() {
  return join(getPluginData(), CODE_GRAPH_DISK_DIR);
}

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

const _HASH_CWD_CACHE_MAX = 50;
const _hashCwdCache = new Map();

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

// Bump when the per-symbol record SHAPE changes (e.g. adding endLine). The
// version is folded into the cache signature so graphs built by an older
// binary/schema (symbols without a finite endLine) no longer match and are
// rebuilt instead of served — otherwise a stale cache would feed endLine-less
// symbols and silently defeat body-span containment in _nearestEnclosingSymbol.
const SYMBOL_SCHEMA_VERSION = 'sym-range-v3-rustimports';
function _computeGraphSignature(fileMetas) {
  const hash = createHash('sha1');
  hash.update(`${SYMBOL_SCHEMA_VERSION}\n`);
  // R5-③: include rel/path alongside fp so renames and path-swaps (same
  // bytes moved to a different rel, or two files exchanging paths) flip
  // the signature and invalidate the memory/disk cache checks at the
  // call sites just below in buildCodeGraphAsync. Without rel, an fp-only
  // hash collides across rename pairs and the cache serves stale graph
  // topology where node.rel no longer matches what's on disk.
  for (const meta of fileMetas) hash.update(`${meta.rel || ''}\0${meta.fp}\n`);
  return hash.digest('hex');
}

function _serializeGraph(graph) {
  // Compact-on-disk: omit empty / falsy fields. Saves ~30-50% on disk
  // for typical mixed-language graphs because most nodes don't carry
  // packageName / namespaceName / topLevelTypes. Smaller
  // payload → faster JSON.parse on cold-process boot. _deserializeGraph
  // tolerates missing fields by defaulting to '' / [].
  return {
    schemaVersion: SYMBOL_SCHEMA_VERSION,
    builtAt: Number(graph?.builtAt || Date.now()),
    signature: String(graph?.signature || ''),
    truncated: Boolean(graph?.truncated),
    maxFiles: CODE_GRAPH_MAX_FILES,
    nodes: [...(graph?.nodes?.values?.() || [])].map((node) => {
      const out = {
        rel: node.rel,
        lang: node.lang,
      };
      if (node.fingerprint) out.fingerprint = node.fingerprint;
      if (Array.isArray(node.rawImports) && node.rawImports.length) out.rawImports = node.rawImports;
      if (Array.isArray(node.resolvedImportsRel) && node.resolvedImportsRel.length) {
        out.resolvedImports = node.resolvedImportsRel;
      }
      if (Array.isArray(node.importedBy) && node.importedBy.length) {
        out.importedBy = node.importedBy;
      }
      if (node.packageName) out.packageName = node.packageName;
      if (node.namespaceName) out.namespaceName = node.namespaceName;
      if (node.goPackageName) out.goPackageName = node.goPackageName;
      if (Array.isArray(node.topLevelTypes) && node.topLevelTypes.length) {
        out.topLevelTypes = node.topLevelTypes;
      }
      if (Array.isArray(node.tokenSymbols) && node.tokenSymbols.length) {
        out.tokenSymbols = node.tokenSymbols;
      }
      if (Array.isArray(node.symbols) && node.symbols.length) {
        out.symbols = node.symbols;
      }
      return out;
    }),
  };
}

function _deserializeGraph(cwd, payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.nodes)) return null;
  const nodes = new Map();
  const reverse = new Map();
  for (const item of payload.nodes) {
    if (!item || typeof item.rel !== 'string' || typeof item.lang !== 'string') continue;
    // Persisted fields are repo-relative, mirroring the live build. The
    // JS resolution layer is gone — resolvedImports/resolvedImportsRel are
    // restored straight from disk; the reverse index is rederived below from
    // the forward edges of every node.
    const resolvedImportsRel = Array.isArray(item.resolvedImports) ? item.resolvedImports.filter((v) => typeof v === 'string') : [];
    const importedBy = Array.isArray(item.importedBy) ? item.importedBy.filter((v) => typeof v === 'string') : [];
    const node = {
      abs: pathResolve(cwd, item.rel),
      rel: item.rel,
      lang: item.lang,
      fingerprint: item.fingerprint || '',
      rawImports: Array.isArray(item.rawImports) ? item.rawImports : [],
      resolvedImportsRel,
      resolvedImports: resolvedImportsRel.map((rel) => pathResolve(cwd, rel)),
      importedBy,
      packageName: item.packageName || '',
      namespaceName: item.namespaceName || '',
      goPackageName: item.goPackageName || '',
      topLevelTypes: Array.isArray(item.topLevelTypes) ? item.topLevelTypes : [],
      tokenSymbols: Array.isArray(item.tokenSymbols) ? item.tokenSymbols : null,
      symbols: Array.isArray(item.symbols) ? item.symbols : [],
    };
    nodes.set(node.rel, node);
    // reverse is derived from the FORWARD edges of every node, not from the
    // persisted importedBy. On the incremental --files path reused nodes carry
    // a stale importedBy, so a fresh edge A→B (A parsed, B reused) would drop
    // B's reverse entry. Walking resolvedImportsRel keeps reverse self-consistent.
    for (const rel of resolvedImportsRel) {
      if (!reverse.has(rel)) reverse.set(rel, new Set());
      reverse.get(rel).add(node.rel);
    }
  }
  const graph = _attachGraphRuntimeCaches({
    cwd,
    nodes,
    reverse,
    // Pre-endLine disk payloads have no schemaVersion → null → dropped by the
    // previousGraph schema guard so their endLine-less nodes never seed reuse.
    schemaVersion: typeof payload.schemaVersion === 'string' ? payload.schemaVersion : null,
    builtAt: Number(payload.builtAt || Date.now()),
    signature: String(payload.signature || ''),
  });
  // Restore the truncation flag persisted from the live build so disk-cache
  // hits keep emitting the WARN line in find_symbol/overview output instead
  // of silently working with a partial graph.
  if (graph && payload.truncated) graph.truncated = true;
  return graph;
}

function _attachGraphRuntimeCaches(graph) {
  if (!graph || typeof graph !== 'object') return graph;
  if (!graph._referenceSearchCache) graph._referenceSearchCache = new Map();
  if (!graph._maskedLinesCache) graph._maskedLinesCache = new Map();
  if (!graph._sourceLinesCache) graph._sourceLinesCache = new Map();
  if (!graph._sourceTextCache) graph._sourceTextCache = new Map();
  if (!graph._symbolTokenIndex) graph._symbolTokenIndex = new Map();
  if (typeof graph._symbolTokenIndexDirty !== 'boolean') graph._symbolTokenIndexDirty = true;
  return graph;
}

function _langUsesDollarInIdentifiers(lang) {
  // `$` is a valid identifier char only in JS/TS/PHP. The 5 new langs are
  // deliberately excluded: kotlin/swift/scala/lua have no `$` in identifiers,
  // and bash's `$` is a variable-expansion sigil (`$var`), not an identifier
  // char — treating it as a word-boundary char would mis-tokenize.
  // Second batch (dart/objc/elixir/zig/r) likewise excluded: none use `$` as
  // an identifier char (objc `$` is invalid; elixir/dart/zig/r have no `$` in
  // names), so they stay out.
  return lang === 'javascript' || lang === 'typescript' || lang === 'php';
}

function _langAllowsBangQuestionSuffix(lang) {
  // Method names may end in `!`/`?` only in ruby (`save!`/`empty?`) and rust
  // (`!` macros). Kotlin is NOT here: its `!!` is the not-null assertion
  // OPERATOR, not an identifier suffix — including it would fold `foo!!` into
  // the `foo` reference and break matching. swift `?`/`!` are optional/
  // force-unwrap operators (not name chars); scala/bash/lua have no suffix.
  // Second batch: elixir function names may end in `?`/`!` (`valid?`/`save!`)
  // exactly like ruby → included. dart/objc/zig/r have no such suffix.
  return lang === 'ruby' || lang === 'rust' || lang === 'elixir';
}

function _estimateGraphRuntimeCacheBytes(graph) {
  if (!graph) return 0;
  let total = 0;
  for (const entry of graph._sourceTextCache?.values() || []) {
    total += Buffer.byteLength(String(entry?.text || ''), 'utf8');
  }
  for (const lines of graph._maskedLinesCache?.values() || []) {
    if (!Array.isArray(lines)) continue;
    for (const line of lines) total += Buffer.byteLength(String(line || ''), 'utf8');
  }
  for (const lines of graph._sourceLinesCache?.values() || []) {
    if (!Array.isArray(lines)) continue;
    for (const line of lines) total += Buffer.byteLength(String(line || ''), 'utf8');
  }
  for (const memo of graph._referenceSearchCache?.values() || []) {
    total += Buffer.byteLength(String(memo || ''), 'utf8');
  }
  return total;
}

function _clearGraphRuntimeCaches(graph) {
  if (!graph) return;
  graph._sourceTextCache?.clear();
  graph._maskedLinesCache?.clear();
  graph._sourceLinesCache?.clear();
  graph._referenceSearchCache?.clear();
  graph._symbolTokenIndex?.clear();
  graph._symbolTokenIndexDirty = true;
}

function _touchCodeGraphCache(graphCwd) {
  const key = _canonicalGraphCwd(graphCwd);
  const entry = _codeGraphCache.get(key);
  if (!entry) return;
  _codeGraphCache.delete(key);
  entry.lastAccess = Date.now();
  _codeGraphCache.set(key, entry);
}

function _setCodeGraphCache(graphCwd, entry) {
  const key = _canonicalGraphCwd(graphCwd);
  const payload = { ...entry, lastAccess: Date.now() };
  if (_codeGraphCache.has(key)) _codeGraphCache.delete(key);
  _codeGraphCache.set(key, payload);
  _pruneCodeGraphMemoryCache();
}

export function _pruneCodeGraphMemoryCache(options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(1, Math.floor(options.maxEntries))
    : CODE_GRAPH_MEMORY_MAX_ENTRIES;
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(0, Math.floor(options.maxBytes))
    : CODE_GRAPH_MEMORY_MAX_SOURCE_BYTES;
  const rows = [..._codeGraphCache.entries()].map(([cwd, entry]) => ({
    cwd,
    entry,
    lastAccess: Number(entry?.lastAccess || entry?.ts || 0),
    runtimeBytes: _estimateGraphRuntimeCacheBytes(entry?.graph),
  }));
  rows.sort((a, b) => (a.lastAccess - b.lastAccess) || String(a.cwd).localeCompare(String(b.cwd)));
  const evicted = [];
  let totalRuntimeBytes = rows.reduce((sum, row) => sum + row.runtimeBytes, 0);
  for (const row of rows) {
    if (totalRuntimeBytes <= maxBytes) break;
    if (!row.entry?.graph || row.runtimeBytes <= 0) continue;
    const freed = row.runtimeBytes;
    _clearGraphRuntimeCaches(row.entry.graph);
    row.runtimeBytes = 0;
    totalRuntimeBytes -= freed;
    evicted.push({ cwd: row.cwd, reason: 'max-bytes-runtime', freed });
  }
  while (_codeGraphCache.size > maxEntries) {
    const oldestKey = _codeGraphCache.keys().next().value;
    if (!oldestKey) break;
    _codeGraphCache.delete(oldestKey);
    evicted.push({ cwd: oldestKey, reason: 'max-entries' });
  }
  return { evicted, totalRuntimeBytes: Math.max(0, totalRuntimeBytes), entries: _codeGraphCache.size };
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
// reading `_diskCodeGraphCache.get(cwd)` so the in-memory cache stays
// populated only for cwds actually looked up in this process lifetime.
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

function _persistDiskCodeGraphCacheNow() {
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
      writeJsonAtomicSync(file, entry, { compact: true, lock: true });
      manifest[cwd] = { hash, builtAt: entry.builtAt || Date.now() };
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
    writeJsonAtomicSync(manifestFile, manifest, { compact: true, lock: true });
    _diskManifest = manifest;

    // Sweep orphan per-cwd files. validHashes now includes every hash in
    // the merged manifest (preserved + ours) so cross-instance cache files
    // are never collateral damage.
    _sweepCodeGraphCacheDir(dir, validHashes, { sweepJson: true });
  } catch (err) {
    process.stderr.write(`[code-graph] disk cache persist failed (target: ${_codeGraphDiskDir()}): ${err?.message || err}\n`);
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
export function drainCodeGraphCache() {
  drainCodeGraphCacheState();
}

/**
 * Fire-and-forget prewarm — schedule a code-graph build for `cwd` on the
 * next tick so the first find_symbol call hits a warm cache instead of
 * paying the cold-build outlier (PG telemetry: avg 4117ms, max 93645ms).
 * Mirrors the warmupCatalogs pattern in providers/registry.mjs (catch-all
 * silent so prewarm never affects the caller). Effect requires that the
 * caller-supplied cwd matches the cwd of the first lookup.
 */
export function prewarmCodeGraph(cwd) {
  if (!cwd) return;
  // Reuse the buildCodeGraphAsync single-flight path. Fire-and-forget —
  // caller does not await. If buildCodeGraphAsync already has a Worker
  // running for this cwd (or the cache is fresh under TTL), prewarm
  // collapses onto it instead of spawning a duplicate thread.
  buildCodeGraphAsync(cwd).catch(() => { /* best-effort */ });
}

/**
 * Symbol-aware prewarm. After graph build, populate the lazy per-symbol
 * candidate cache for each name in `symbols` so the first find_symbol
 * lookup on those names skips the ~50ms O(N) node scan. Best paired
 * with agent prefetch args (prefetch.callers / prefetch.references)
 * that already name the symbols the worker plans to query. Fire-and-
 * forget; caller does not await.
 */
export function prewarmCodeGraphSymbols(cwd, symbols, { language = null } = {}) {
  if (!cwd) return;
  const wanted = (Array.isArray(symbols) ? symbols : [symbols])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  buildCodeGraphAsync(cwd).then((graph) => {
    if (!graph) return;
    for (const symbol of wanted) {
      try { _lookupCandidateNodes(graph, symbol, language); } catch { /* best-effort */ }
    }
  }).catch(() => { /* best-effort */ });
}

/**
 * Guarded directory prewarm. Schedules a build ONLY when `cwd` sits inside a
 * real project (sentinel at it or an ancestor), and prewarms the detected
 * project ROOT — not an arbitrary subdir — so a later unscoped query (which
 * re-roots to that same project root in executeCodeGraphTool) lands on a warm
 * cache instead of paying the cold build on the query's critical path. Refuses
 * non-project trees (home dir, multi-repo container, plugin cache) so a stray
 * `cwd set` never burns a worker indexing a giant unrelated tree. Fire-and-
 * forget (single-flight + silent via prewarmCodeGraph); returns whether a
 * prewarm was scheduled.
 */
export function prewarmCodeGraphIfProject(cwd) {
  if (!cwd) return false;
  const root = _findDirProjectRoot(cwd);
  if (!root) return false;
  prewarmCodeGraph(root);
  return true;
}

export async function buildCodeGraphAsync(cwd, signal = null) {
  if (signal?.aborted) throw new Error('aborted');
  const graphCwd = _canonicalGraphCwd(cwd);
  // TTL-bounded cache hit. Signature re-validation requires a sync fs
  // walk (main-loop work we explicitly avoid), so we delegate full
  // re-check to the worker which calls _buildCodeGraph and runs the
  // signature comparison itself. Stale entries past CODE_GRAPH_TTL_MS
  // fall through to a worker rebuild.
  const cached = _codeGraphCache.get(graphCwd);
  if (cached?.graph && Date.now() - cached.ts < CODE_GRAPH_TTL_MS) {
    _touchCodeGraphCache(graphCwd);
    return cached.graph;
  }
  // Single-flight: parallel callers for the same graphCwd collapse onto
  // one Worker spawn. Same Promise is returned to every caller until it
  // settles, then the entry is removed so subsequent callers can retry
  // after a failure or after the next TTL expiry.
  const existing = _inflightAsyncBuilds.get(graphCwd);
  if (existing) {
    if (!signal) return existing;
    let onAbort = null;
    const abortP = new Promise((_, reject) => {
      onAbort = () => reject(new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const cleanup = () => {
      if (onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
        onAbort = null;
      }
    };
    return Promise.race([existing, abortP]).then(
      (v) => { cleanup(); return v; },
      (e) => { cleanup(); throw e; },
    );
  }
  // Capture the dirty generation at build start. If a write bumps it
  // before the worker returns, the result describes a pre-edit tree and
  // must be dropped rather than cached/persisted.
  const _genAtStart = _getCodeGraphGen(graphCwd);
  let _worker = null;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    let _onSignalAbort = null;
    // child-spawn-gate slot held on the MAIN THREAD for the whole graph-build
    // worker lifetime. The native mixdog-graph child is spawned from inside
    // the worker thread (which has its own, non-shared module state), so the
    // gate cannot be acquired at the spawn site without forking a second,
    // uncoordinated semaphore. We accept a slightly WIDER hold window than the
    // bare binary spawn — the worker also does sync fs walk / parse glue — as
    // the explicit tradeoff for keeping native graph spawns counted against the
    // same single semaphore as rg. Released exactly once in settle().
    let _releaseSlot = null;
    const settle = (val) => {
      if (settled) return;
      settled = true;
      if (timeout) { clearTimeout(timeout); timeout = null; }
      if (_onSignalAbort && signal) {
        try { signal.removeEventListener('abort', _onSignalAbort); } catch {}
        _onSignalAbort = null;
      }
      if (_releaseSlot) { try { _releaseSlot(); } catch {} _releaseSlot = null; }
      _inflightAsyncBuilds.delete(graphCwd);
      if (val instanceof Error) reject(val);
      else resolve(val);
    };
    // Acquire the gate slot BEFORE spawning the worker. Over-saturation queues
    // here (excess builds wait) while the cap's worth run; an abort while still
    // queued rejects acquire → settle(error) with no worker created/leaked.
    acquireChildSpawnSlot(signal || null).then((release) => {
      _releaseSlot = release;
      if (settled) { release(); _releaseSlot = null; return; }
      const workerUrl = new URL('./code-graph-prewarm-worker.mjs', import.meta.url);
      _worker = new Worker(workerUrl, {
        workerData: { cwd },
        execArgv: [],
      });
      const w = _worker;
      timeout = setTimeout(() => {
        try { _worker?.terminate(); } catch {}
        settle(new Error(`code-graph worker timed out after ${CODE_GRAPH_WORKER_TIMEOUT_MS}ms for cwd=${graphCwd}`));
      }, CODE_GRAPH_WORKER_TIMEOUT_MS);
      timeout.unref?.();
      if (signal) {
        _onSignalAbort = () => {
          try { _worker?.terminate(); } catch {}
          settle(new Error('aborted'));
        };
        signal.addEventListener('abort', _onSignalAbort, { once: true });
      }
      w.once('message', (msg) => {
        try {
          if (msg && msg.ok && msg.graph && typeof msg.signature === 'string') {
            // Dirty-generation guard: only commit if no write invalidated
            // this root since build start. A stale result is still returned
            // to in-flight callers but never cached or persisted, so the TTL
            // fast path won't serve a pre-edit graph after the next rebuild.
            if (_getCodeGraphGen(graphCwd) === _genAtStart) {
              _setCodeGraphCache(graphCwd, { ts: Date.now(), signature: msg.signature, graph: msg.graph });
              // Mirror the sync build path: persist to disk so the next
              // process boot can hit the cache cold. Without this, async
              // prewarm / find_symbol via worker thread populated only the
              // in-memory map and the per-cwd directory stayed empty until
              // the rare sync rebuild path landed.
              _setDiskCodeGraphEntry(graphCwd, msg.graph);
            }
            settle(msg.graph);
          } else {
            settle(new Error('code-graph prewarm worker failed'));
          }
        } catch (e) { settle(e instanceof Error ? e : new Error(String(e))); }
      });
      w.once('error', (e) => settle(e instanceof Error ? e : new Error(String(e))));
    }, (e) => settle(e instanceof Error ? e : new Error(String(e))));
  });
  _inflightAsyncBuilds.set(graphCwd, promise);
  return promise;
}

function _setDiskCodeGraphEntry(cwd, graph) {
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

// Unicode-aware word-boundary wrapper for an already-regex-escaped
// symbol. JS `\b` only fires at ASCII [A-Za-z0-9_] transitions, so
// CJK / Cyrillic / Greek identifiers never matched the legacy shape.
// `$` is part of the boundary only for JS/TS/PHP; Ruby/Kotlin/Rust
// `!?` suffixes are kept distinct from the unsuffixed name when searching.
function _unicodeBoundaryPattern(escaped, lang = null, symbol = null) {
  const allowDollar = !lang || _langUsesDollarInIdentifiers(lang);
  const before = allowDollar ? '(?<![\\p{ID_Continue}$])' : '(?<![\\p{ID_Continue}])';
  let after = allowDollar ? '(?![\\p{ID_Continue}$])' : '(?![\\p{ID_Continue}])';
  const sym = symbol == null ? '' : String(symbol);
  if (lang && _langAllowsBangQuestionSuffix(lang) && sym && !/[!?]$/.test(sym)) {
    after = allowDollar ? '(?![\\p{ID_Continue}$!?])' : '(?![\\p{ID_Continue}!?])';
  }
  return `${before}${escaped}${after}`;
}

function _extractIdentifierTokens(text, lang = null) {
  const out = new Set();
  const allowDollar = !lang || _langUsesDollarInIdentifiers(lang);
  const before = allowDollar ? '(?<![\\p{ID_Continue}$])' : '(?<![\\p{ID_Continue}])';
  const suffix = lang && _langAllowsBangQuestionSuffix(lang) ? '[!?]?' : '';
  const after = allowDollar ? '(?![\\p{ID_Continue}$])' : '(?![\\p{ID_Continue}])';
  const re = new RegExp(`${before}[$@]?[\\p{ID_Start}_][\\p{ID_Continue}]*${suffix}${after}`, 'gu');
  let match = null;
  const src = String(text || '');
  while ((match = re.exec(src))) {
    out.add(match[0]);
  }
  return [...out];
}

function _getTokenSymbolsForNode(graph, node) {
  if (Array.isArray(node?.tokenSymbols)) return node.tokenSymbols;
  const text = _getSourceTextForNode(graph, node);
  const tokens = _extractIdentifierTokens(text, node.lang);
  node.tokenSymbols = tokens;
  return tokens;
}

// Legacy full-index builder. Kept callable for explicit prewarms, but
// no longer invoked from lookup paths — those use _lookupCandidateNodes
// which lazily builds only the requested (language, symbol) bucket.
// Full build was the dominant cold-process cost (~1-2s on refs/'s
// 7000-node × ~50-tokens graph) and provided no benefit for the typical
// 1-3 lookups per agent worker.
function _ensureSymbolTokenIndex(graph) {
  if (!graph?._symbolTokenIndex) return;
  if (!graph._symbolTokenIndexDirty && graph._symbolTokenIndex.size > 0) return;
  graph._symbolTokenIndex.clear();
  for (const node of graph.nodes.values()) {
    for (const symbol of _getTokenSymbolsForNode(graph, node)) {
      const langKey = `${node.lang}|${symbol}`;
      const wildKey = `*|${symbol}`;
      if (!graph._symbolTokenIndex.has(langKey)) graph._symbolTokenIndex.set(langKey, []);
      graph._symbolTokenIndex.get(langKey).push(node.rel);
      if (!graph._symbolTokenIndex.has(wildKey)) graph._symbolTokenIndex.set(wildKey, []);
      graph._symbolTokenIndex.get(wildKey).push(node.rel);
    }
  }
  graph._symbolTokenIndexDirty = false;
}

// Lazy per-symbol candidate lookup. Caches the result back into
// `_symbolTokenIndex` so repeat lookups are O(1). Compared to a full
// _ensureSymbolTokenIndex sweep, the per-symbol scan is O(N) where N is
// the node count (~7000 on refs/), and each node's check is a cheap
// Array.includes on its pre-extracted tokenSymbols. Cold-process first
// lookup drops from ~1-2s to ~50ms.
export function _lookupCandidateNodes(graph, symbol, language = null) {
  if (!graph?.nodes) return [];
  const cacheKey = `${language || '*'}|${symbol}`;
  if (graph._symbolTokenIndex?.has(cacheKey)) {
    const rels = graph._symbolTokenIndex.get(cacheKey);
    return rels.map((rel) => graph.nodes.get(rel)).filter(Boolean);
  }
  const candidates = [];
  for (const node of graph.nodes.values()) {
    if (language && node.lang !== language) continue;
    const tokens = _getTokenSymbolsForNode(graph, node);
    if (tokens.includes(symbol)) candidates.push(node);
  }
  if (candidates.length > 0) {
    if (graph._symbolTokenIndex) {
      graph._symbolTokenIndex.set(cacheKey, candidates.map((n) => n.rel));
    }
    return candidates;
  }
  // Token-index miss → fall back to language-filtered full graph scan.
  // _extractIdentifierTokens uses ASCII `\b` word-boundary which misses
  // unicode (Korean/CJK), $-prefixed identifiers in some positions, and
  // certain multi-byte language tokens (Rust raw idents, Go method
  // receivers). The downstream search loop's sourceText.includes()
  // still catches these — we just need to give it the full node set.
  // Not cached: caching the fallback would mask token-extractor
  // improvements and would also keep returning the heavy scan after a
  // future graph rebuild populated the token map for the symbol.
  const fallback = [];
  for (const node of graph.nodes.values()) {
    if (language && node.lang !== language) continue;
    fallback.push(node);
  }
  return fallback;
}

function _extractSymbolsCheap(text, lang) {
  const all = _collectCheapSymbols(text, lang).map((item) => `${item.kind} ${item.name} (L${item.line})`);
  return all.length ? _capGraphList(all).join('\n') : '(no symbols)';
}

// Control-flow keywords that the bare `name(args) {?$` patterns below
// would otherwise mis-collect as function/method symbols (e.g. an
// `if (...) {` line). Excluding at the collection stage keeps the
// invariant out of every downstream label/summarizer.
const _CHEAP_SYMBOL_CONTROL_FLOW = new Set([
  'if', 'else', 'elif', 'for', 'foreach', 'while', 'do',
  'switch', 'case', 'default', 'when', 'select',
  'try', 'catch', 'finally', 'throw', 'throws',
  'return', 'yield', 'await', 'goto', 'break', 'continue',
  'with', 'using', 'lock', 'synchronized', 'unless',
]);

function _collectCheapSymbols(text, lang) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const push = (kind, name, idx) => {
    if (!name) return;
    // Skip control-flow keywords so `if(...) {`, `for(...) {`,
    // `while(...) {`, `switch(...) {`, `catch(...) {` no longer leak
    // as function/method symbols through the bare `name(args)` shapes.
    if (_CHEAP_SYMBOL_CONTROL_FLOW.has(name)) return;
    out.push({ kind, name, line: idx + 1 });
  };
  // Slash (`//` `/*`) comments: all C-family langs incl. new kotlin/swift/
  // scala. Excluded: python/ruby (hash), bash (hash), lua (`--`; also `//`
  // is lua integer-division, so slash-stripping would delete code). Second
  // batch: dart/objc/zig are C-family slash-comment (kept by the default);
  // elixir/r are hash-comment (excluded below).
  const supportsSlash = lang !== 'python' && lang !== 'ruby'
    && lang !== 'bash' && lang !== 'lua'
    && lang !== 'elixir' && lang !== 'r';
  // Hash (`#`) comments: python/ruby/php and bash. lua uses `--` (handled by
  // _maskNonCodeText, not needed here since lua has no cheap-symbol matcher).
  // Second batch: elixir and r are `#`-only line-comment langs → included.
  const supportsHash = lang === 'python' || lang === 'ruby' || lang === 'php'
    || lang === 'bash' || lang === 'elixir' || lang === 'r';
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    // Per-line comment stripping at the collection stage so header/JSDoc
    // words like "These", "side", "effects" cannot bleed into the
    // overview `symbols:` token list or the cheap summarizer output.
    // An unclosed `/*` keeps the code before it and flips the block flag
    // so code-before-comment lines (and spaced generators like `* gen()`)
    // still reach the per-language matchers below.
    let line = lines[i];
    if (supportsSlash) {
      if (inBlockComment) {
        const endIdx = line.indexOf('*/');
        if (endIdx < 0) continue;
        line = line.slice(endIdx + 2);
        inBlockComment = false;
      }
      while (true) {
        const startIdx = line.indexOf('/*');
        if (startIdx < 0) break;
        const endIdx = line.indexOf('*/', startIdx + 2);
        if (endIdx < 0) {
          line = line.slice(0, startIdx);
          inBlockComment = true;
          break;
        }
        line = line.slice(0, startIdx) + ' ' + line.slice(endIdx + 2);
      }
      const slashIdx = line.indexOf('//');
      if (slashIdx >= 0) line = line.slice(0, slashIdx);
    }
    if (supportsHash) {
      if (/^\s*#/.test(line)) continue;
    }
    if (!line.trim()) continue;
    let m = null;
    if (lang === 'typescript' || lang === 'javascript') {
      if ((m = /\b(class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
      else if ((m = /\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line))) push('binding', m[1], i);
      else if ((m = /^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('method', m[1], i);
    } else if (lang === 'python') {
      if ((m = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('class', m[1], i);
      else if ((m = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('function', m[1], i);
    } else if (lang === 'go') {
      if ((m = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/.exec(line))) push('struct', m[1], i);
      else if ((m = /^\s*func(?:\s*\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
    } else if (lang === 'rust') {
      if ((m = /^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('struct', m[1], i);
      else if ((m = /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
    } else if (lang === 'kotlin') {
      // Kotlin: `fun name(...)` is the canonical function declaration whether
      // the body is a `{` block or an `= expr` expression body. The shared
      // Java/C#-style `name(...) {` pattern misses expression bodies that
      // end with the expression itself (no trailing `{` or `;`), so caller
      // names disappear for those functions.
      if ((m = /\b(class|interface|enum|object)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:open\s+|abstract\s+|final\s+)?(?:override\s+)?(?:suspend\s+)?(?:inline\s+)?fun\s+(?:<[^>]+>\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
      else if ((m = /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:const\s+)?(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line))) push('binding', m[1], i);
    } else if (lang === 'java' || lang === 'csharp') {
      if ((m = /\b(class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('function', m[1], i);
    } else if (lang === 'c' || lang === 'cpp') {
      if ((m = /\b(class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /^\s*[A-Za-z_][\w\s:*<>~]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('function', m[1], i);
    } else if (lang === 'ruby' || lang === 'php') {
      if ((m = /^\s*class\s+([A-Za-z_][A-Za-z0-9_:]*)/.exec(line))) push('class', m[1], i);
      else if ((m = /^\s*def\s+([A-Za-z_][A-Za-z0-9_!?=]*)/.exec(line))) push('function', m[1], i);
    }
    // No cheap-regex matcher for swift/scala/bash/lua or the second batch
    // (dart/objc/elixir/zig/r): the native indexer now emits symbols for these
    // langs, so _collectCheapSymbols runs only as a fallback when native
    // symbols are absent. They are deliberately left without a branch (yield no
    // cheap anchors) rather than guessing with a loose pattern; callers
    // (overview/anchors) fall back to native symbols.
  }
  return out;
}

// Raised from 6 to 50 after HS-A6 surfaced that overview on a ~46KB file
// returned only the first 6 anchors (all within the first 87 lines, 5%
// of the file). tail-trim still bounds output payload, so a higher cap
// surfaces full structure on large files without hurting small ones.
function _extractExplainerAnchorLines(node, graph, { limit = 50, maxLineChars = 180 } = {}) {
  const sourceLines = _getSourceTextForNode(graph, node).split(/\r?\n/);
  const symbols = Array.isArray(node.symbols) && node.symbols.length
    ? node.symbols
    : _collectCheapSymbols(sourceLines.join('\n'), node.lang);
  const out = [];
  const seen = new Set();
  for (const item of symbols) {
    if (out.length >= limit) break;
    const idx = item.line - 1;
    const line = String(sourceLines[idx] || '').trim();
    if (!line) continue;
    const key = `${item.name}:${item.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${item.kind} ${item.name} (L${item.line}): ${line.slice(0, maxLineChars)}`);
  }
  return out;
}

function _graphRel(absPath, cwd) {
  return toDisplayPath(absPath, cwd);
}

// When a "file not found in graph" error fires, the model often hallucinated
// a plausible-looking path (e.g. src/runtime/agent/loop.mjs) that shares its
// basename with a real, differently-located file already in the graph. Scan
// the in-memory graph.nodes keys (no filesystem access) for a case-insensitive
// basename match and append a recovery hint so the next call can self-correct
// in one turn instead of a blind re-grep.
function _appendSameBasenameHint(message, normFile, graph) {
  const raw = String(normFile || '');
  const base = raw.replace(/\\/g, '/').split('/').pop();
  if (!base || !graph?.nodes) return message;
  const baseLower = base.toLowerCase();
  const matches = [];
  for (const key of graph.nodes.keys()) {
    if (key.split('/').pop().toLowerCase() === baseLower) {
      matches.push(key);
      if (matches.length >= 5) break;
    }
  }
  if (!matches.length) return message;
  return `${message} Same filename exists in graph at: ${matches.map((m) => `"${m}"`).join(', ')}. Use that path.`;
}


function _supportsHashComments(lang) {
  // Hash-comment langs: python/ruby/php plus bash. lua is NOT hash — it uses
  // `--` line + `--[[ ]]` block comments (see _maskNonCodeText). kotlin/
  // swift/scala are slash-comment C-family (see _supportsSlashComments).
  // Second batch: elixir and r are `#`-only line-comment langs → included.
  // (dart/objc/zig are slash-comment, handled by _supportsSlashComments.)
  return lang === 'python' || lang === 'ruby' || lang === 'php'
    || lang === 'bash' || lang === 'elixir' || lang === 'r';
}

function _supportsSlashComments(lang) {
  // Slash-comment langs: everything C-family, incl. new kotlin/swift/scala.
  // Excluded: python/ruby/bash (hash) and lua (`--` comments; `//` is lua
  // integer division, so it must not be treated as a comment opener).
  // Second batch: dart/objc/zig are C-family slash-comment (kept by the
  // default). Excluded here: elixir/r (hash-only, see _supportsHashComments).
  return lang !== 'python' && lang !== 'ruby'
    && lang !== 'bash' && lang !== 'lua'
    && lang !== 'elixir' && lang !== 'r';
}

function _supportsSingleQuoteStrings(lang) {
  return lang === 'typescript'
    || lang === 'javascript'
    || lang === 'python'
    || lang === 'ruby'
    || lang === 'php'
    // New langs with single-quote string literals: swift uses double quotes
    // only (excluded); kotlin uses double/triple-double (excluded); scala
    // single-quotes are Char literals not strings (excluded); bash and lua
    // both support `'...'` single-quoted strings.
    || lang === 'bash'
    || lang === 'lua'
    // Second batch. dart: `'...'` is a primary string form → included. r:
    // `'...'` is a string literal equivalent to `"..."` → included. objc:
    // `'x'` is a char literal — INCLUDED here so its contents are masked as a
    // single-quote string. This deliberately DIVERGES from c/cpp, which are
    // NOT in this list: objc's masker benefits from neutralizing char-literal
    // bytes, whereas c/cpp char literals are left unmasked.
    // elixir: EXCLUDED — `'...'` is a charlist, not a string; but charlists
    // are single-line and `\\`-escaped just like a string, so masking them as
    // strings would be safe — they are nonetheless left out to keep elixir
    // string handling limited to `"..."`/`"""` (charlist contents are rare in
    // code-graph anchors and excluding avoids masking a stray apostrophe in a
    // comment-less context). zig: EXCLUDED — `'c'` is a char literal only and
    // zig multiline strings are `\\`-prefixed lines (out of scope), so no
    // single-quote string form applies.
    || lang === 'dart'
    || lang === 'r'
    || lang === 'objc';
}

function _supportsBacktickStrings(lang) {
  return lang === 'typescript' || lang === 'javascript' || lang === 'go';
}

function _supportsTripleSingleQuoteStrings(lang) {
  // `'''` triple-single-quote strings: python, and dart (which supports BOTH
  // `'''` and `"""` multiline strings). kotlin/scala/swift have `"""` but NOT
  // `'''`; treating `'''` as a string opener there would mis-mask a
  // single-quote char/string followed by an empty string.
  return lang === 'python' || lang === 'dart';
}

function _supportsTripleDoubleQuoteStrings(lang) {
  // `"""` triple-double-quote raw/multiline strings: python, kotlin, scala
  // and swift. bash/lua have no triple-quote form (lua long strings use
  // `[[ ]]`).
  // Second batch: elixir `"""` heredoc docstrings → included. dart supports
  // BOTH `'''` and `"""` multiline strings → included here (and in the triple-
  // single predicate). objc/zig/r have no `"""` form.
  return lang === 'python' || lang === 'kotlin'
    || lang === 'scala' || lang === 'swift' || lang === 'elixir'
    || lang === 'dart';
}

function _isJsLike(lang) {
  return lang === 'javascript' || lang === 'typescript';
}

function _isWordStartChar(c) {
  return c === '_' || c === '$'
    || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function _isWordChar(c) {
  return _isWordStartChar(c) || (c >= '0' && c <= '9');
}

// ECMAScript expression-context keywords that can precede a regex literal.
// After any of these, a `/` opens a RegExp literal; after a value (identifier,
// number, `)`, `]`), `/` is the division operator. This list is from the
// language spec — not a heuristic — and resolves the `/`-ambiguity.
const REGEX_PRECEDENT_KEYWORDS = new Set([
  'return', 'typeof', 'delete', 'void', 'new', 'throw', 'await', 'yield',
  'in', 'of', 'instanceof', 'case', 'do', 'else', 'if', 'while',
]);

const REGEX_PRECEDENT_CHARS = new Set([
  '=', '(', ',', ';', ':', '?', '!', '~', '&', '|', '^', '+', '-',
  '*', '%', '<', '>', '{', '[',
]);

// Mask a JS regex literal body starting at `start` (which points at `/`).
// Handles `\` escapes and `[...]` character classes per ECMAScript spec.
// Returns the index just past the closing `/flags`. Bytes between the
// delimiters are replaced with spaces in `out` so downstream identifier
// searches do not see them.
function _maskJsRegexLiteral(src, out, start) {
  if (src[start] !== '\n') out[start] = ' ';
  let j = start + 1;
  let inCharClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\n') return j;
    if (c === '\\') {
      if (src[j] !== '\n') out[j] = ' ';
      if (j + 1 < src.length && src[j + 1] !== '\n') out[j + 1] = ' ';
      j += 2;
      continue;
    }
    if (c === '[' && !inCharClass) {
      inCharClass = true;
      if (src[j] !== '\n') out[j] = ' ';
      j++;
      continue;
    }
    if (c === ']' && inCharClass) {
      inCharClass = false;
      if (src[j] !== '\n') out[j] = ' ';
      j++;
      continue;
    }
    if (c === '/' && !inCharClass) {
      if (src[j] !== '\n') out[j] = ' ';
      j++;
      while (j < src.length && src[j] >= 'a' && src[j] <= 'z') {
        if (src[j] !== '\n') out[j] = ' ';
        j++;
      }
      return j;
    }
    if (src[j] !== '\n') out[j] = ' ';
    j++;
  }
  return j;
}

function _maskNonCodeText(text, lang) {
  const src = String(text || '');
  const out = src.split('');
  let i = 0;
  let blockComment = false;
  // Stack of scanner frames. Top describes current state:
  //   { kind: 'string', delim }       — inside single-line string literal (mask body)
  //   { kind: 'triple', delim }       — inside triple-quote string (mask body)
  //   { kind: 'interp', braceDepth }  — inside backtick `${...}` interpolation
  //                                     (code mode; bytes preserved so callers
  //                                     analysis can see fn-calls inside)
  // Empty stack = top-level code.
  const stack = [];
  const top = () => (stack.length ? stack[stack.length - 1] : null);
  // prevToken tracks ECMAScript token context for the `/`-disambiguation:
  //   'expr'  = expression-start (regex literal may follow)
  //   'value' = value/operand (`/` is division)
  // Start of file = expression context.
  let prevToken = 'expr';
  while (i < src.length) {
    if (blockComment) {
      if (src.startsWith('*/', i)) {
        out[i] = ' ';
        if (i + 1 < out.length) out[i + 1] = ' ';
        i += 2;
        blockComment = false;
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    const t = top();
    if (t && t.kind === 'triple') {
      if (src.startsWith(t.delim, i)) {
        for (let j = 0; j < t.delim.length; j++) {
          if (src[i + j] !== '\n') out[i + j] = ' ';
        }
        i += t.delim.length;
        stack.pop();
        prevToken = 'value';
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (t && t.kind === 'luablock') {
      // Lua long-bracket comment `--[=*[ ... ]=*]` — mask until the EXACT
      // matching close delimiter (`]` + same number of `=` + `]`) recorded
      // on the frame, so `--[==[ ]] ]==]` closes only at `]==]`.
      if (t.close && src.startsWith(t.close, i)) {
        for (let j = 0; j < t.close.length; j++) {
          if (src[i + j] !== '\n') out[i + j] = ' ';
        }
        i += t.close.length;
        stack.pop();
        prevToken = 'value';
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (t && t.kind === 'string') {
      const d = t.delim;
      if (d === '`' && src.startsWith('${', i)) {
        // Enter interpolation. `${` itself is code-relevant — leave bytes intact.
        stack.push({ kind: 'interp', braceDepth: 1 });
        i += 2;
        prevToken = 'expr';
        continue;
      }
      // In bash single-quotes `'...'`, backslash is literal (no escape) — the
      // string closes at the first `'`. Skip the escape consumption there so
      // `'\'` is not mis-read as an escaped quote. bash `"..."` and all other
      // langs keep backslash-escape handling.
      const bashLiteralSingle = t.lang === 'bash' && d === '\'';
      if (!bashLiteralSingle && src[i] === '\\' && (d === '\'' || d === '"' || d === '`')) {
        if (src[i] !== '\n') out[i] = ' ';
        if (i + 1 < src.length && src[i + 1] !== '\n') out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (src[i] === d) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
        stack.pop();
        prevToken = 'value';
        continue;
      }
      // JS forbids a raw newline inside '...' or "..." — defensive reset. bash
      // quoted strings legally span newlines, so do NOT reset bash frames.
      if (src[i] === '\n' && t.lang !== 'bash' && (d === '\'' || d === '"')) {
        stack.pop();
        prevToken = 'value';
        i++;
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (t && t.kind === 'interp') {
      // Code mode inside `${...}`. Bytes preserved; track brace depth and
      // nested constructs so masking resumes once interpolation closes.
      if (src[i] === '{') {
        t.braceDepth++;
        prevToken = 'expr';
        i++;
        continue;
      }
      if (src[i] === '}') {
        t.braceDepth--;
        i++;
        if (t.braceDepth === 0) {
          stack.pop();
          prevToken = 'value';
        } else {
          prevToken = 'value';
        }
        continue;
      }
      if (_supportsSlashComments(lang) && src.startsWith('/*', i)) {
        out[i] = ' ';
        if (i + 1 < out.length) out[i + 1] = ' ';
        i += 2;
        blockComment = true;
        continue;
      }
      if (_supportsSlashComments(lang) && src.startsWith('//', i)) {
        while (i < src.length && src[i] !== '\n') {
          out[i] = ' ';
          i++;
        }
        continue;
      }
      if (src[i] === '/' && _isJsLike(lang) && prevToken === 'expr') {
        i = _maskJsRegexLiteral(src, out, i);
        prevToken = 'value';
        continue;
      }
      if (src[i] === '"' || (_supportsSingleQuoteStrings(lang) && src[i] === '\'') || (_supportsBacktickStrings(lang) && src[i] === '`')) {
        if (src[i] !== '\n') out[i] = ' ';
        stack.push({ kind: 'string', delim: src[i], lang });
        i++;
        continue;
      }
      if (_isWordStartChar(src[i])) {
        const start = i;
        while (i < src.length && _isWordChar(src[i])) i++;
        const word = src.substring(start, i);
        prevToken = REGEX_PRECEDENT_KEYWORDS.has(word) ? 'expr' : 'value';
        continue;
      }
      if (src[i] >= '0' && src[i] <= '9') {
        while (i < src.length && (src[i] === '.' || (src[i] >= '0' && src[i] <= '9'))) i++;
        prevToken = 'value';
        continue;
      }
      if (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n') {
        i++;
        continue;
      }
      if (REGEX_PRECEDENT_CHARS.has(src[i])) {
        prevToken = 'expr';
      } else {
        prevToken = 'value';
      }
      i++;
      continue;
    }
    // Top-level code.
    if (_supportsSlashComments(lang) && src.startsWith('/*', i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      i += 2;
      blockComment = true;
      continue;
    }
    if (_supportsSlashComments(lang) && src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (_supportsHashComments(lang) && src[i] === '#') {
      // Bash `#` is a comment ONLY at line start or after whitespace. When it
      // follows a non-space char it is part of `${var#pat}` / `${var##pat}`
      // parameter expansion (or `$#`, `arr[#]`, etc.), NOT a comment — masking
      // there would erase the rest of the line. `#!` shebang sits at file
      // start (a line start) so it is still masked.
      if (lang === 'bash') {
        const prev = i > 0 ? src[i - 1] : '\n';
        const atCommentPos = prev === '\n' || prev === ' ' || prev === '\t' || prev === '\r';
        if (!atCommentPos) {
          prevToken = 'value';
          i++;
          continue;
        }
      }
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    // Lua comments: `--[=*[ ... ]=*]` long-bracket block and `--` line. Lua is
    // neither slash nor hash (see comment predicates), so it needs this
    // dedicated branch. Checked before number/operator handling so the leading
    // `--` is consumed as a comment, not as two minus operators.
    if (lang === 'lua' && src.startsWith('--', i)) {
      // Long-bracket opener: `--` then `[` + zero-or-more `=` + `[`. The level
      // (`=` count) selects the matching close `]` + same `=` + `]`.
      const lb = /^--\[(=*)\[/.exec(src.slice(i, i + 64));
      if (lb) {
        const open = lb[0];
        for (let j = 0; j < open.length; j++) {
          if (src[i + j] !== '\n') out[i + j] = ' ';
        }
        i += open.length;
        stack.push({ kind: 'luablock', close: `]${lb[1]}]` });
        continue;
      }
      // Plain `--` line comment (no long-bracket opener follows).
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (_supportsTripleSingleQuoteStrings(lang) && src.startsWith("'''", i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      if (i + 2 < out.length) out[i + 2] = ' ';
      i += 3;
      stack.push({ kind: 'triple', delim: "'''" });
      continue;
    }
    if (_supportsTripleDoubleQuoteStrings(lang) && src.startsWith('"""', i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      if (i + 2 < out.length) out[i + 2] = ' ';
      i += 3;
      stack.push({ kind: 'triple', delim: '"""' });
      continue;
    }
    if (src[i] === '/' && _isJsLike(lang) && prevToken === 'expr') {
      i = _maskJsRegexLiteral(src, out, i);
      prevToken = 'value';
      continue;
    }
    if (src[i] === '"' || (_supportsSingleQuoteStrings(lang) && src[i] === '\'') || (_supportsBacktickStrings(lang) && src[i] === '`')) {
      if (src[i] !== '\n') out[i] = ' ';
      stack.push({ kind: 'string', delim: src[i], lang });
      i++;
      continue;
    }
    if (_isWordStartChar(src[i])) {
      const start = i;
      while (i < src.length && _isWordChar(src[i])) i++;
      const word = src.substring(start, i);
      prevToken = REGEX_PRECEDENT_KEYWORDS.has(word) ? 'expr' : 'value';
      continue;
    }
    if (src[i] >= '0' && src[i] <= '9') {
      while (i < src.length && (src[i] === '.' || (src[i] >= '0' && src[i] <= '9'))) i++;
      prevToken = 'value';
      continue;
    }
    if (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n') {
      i++;
      continue;
    }
    if (REGEX_PRECEDENT_CHARS.has(src[i])) {
      prevToken = 'expr';
    } else {
      prevToken = 'value';
    }
    i++;
  }
  return out.join('');
}

function _getSourceTextForNode(graph, node, fallbackText = null) {
  const cached = graph?._sourceTextCache?.get(node.rel);
  if (cached && cached.fingerprint === (node.fingerprint || '')) {
    return cached.text;
  }
  if (typeof fallbackText === 'string') {
    graph?._sourceTextCache?.set(node.rel, {
      fingerprint: node.fingerprint || '',
      text: fallbackText,
    });
    return fallbackText;
  }
  let text = '';
  let readOk = false;
  try { text = readFileSync(node.abs, 'utf8'); readOk = true; } catch { text = ''; readOk = false; }
  if (readOk) {
    graph?._sourceTextCache?.set(node.rel, {
      fingerprint: node.fingerprint || '',
      text,
    });
  }
  return text;
}

function _buildExplainerFileSummary(node, graph, cwd) {
  const topTypes = Array.isArray(node?.topLevelTypes) ? node.topLevelTypes.slice(0, 8) : [];
  const importsAll = Array.isArray(node?.resolvedImports) ? node.resolvedImports.map((p) => _graphRel(p, cwd)) : [];
  const imports = importsAll.slice(0, 8);
  const tokensAll = _getTokenSymbolsForNode(graph, node);
  // Prefer native tree-sitter symbol names (declarations only — no
  // comment/string/keyword leakage); fall back to the regex token dump
  // only when the native graph path didn't populate node.symbols.
  const hasNativeSymbols = Array.isArray(node?.symbols) && node.symbols.length > 0;
  const symbolsAll = hasNativeSymbols
    ? [...new Set(node.symbols.map((s) => s.name))]
    : tokensAll;
  const symbolNames = symbolsAll.slice(0, hasNativeSymbols ? 30 : 20);
  const anchors = _extractExplainerAnchorLines(node, graph);
  const sourceHead = _getSourceTextForNode(graph, node)
    .split(/\r?\n/)
    .slice(0, 6)
    .join('\n')
    .trim()
    .slice(0, 420);
  const parts = [
    `file: ${node.rel}`,
    `language: ${node.lang}`,
  ];
  if (topTypes.length) parts.push(`top-level: ${topTypes.join(', ')}`);
  // A capped list with no marker reads as "this is everything" — when cut,
  // say so and point at the uncapped mode.
  if (symbolNames.length) {
    const more = symbolsAll.length - symbolNames.length;
    parts.push(`symbols: ${symbolNames.join(', ')}${more > 0 ? `, … +${more} more (mode:symbols for full list)` : ''}`);
  }
  if (imports.length) {
    const more = importsAll.length - imports.length;
    parts.push(`imports: ${imports.join(', ')}${more > 0 ? `, … +${more} more (mode:imports for full list)` : ''}`);
  }
  if (anchors.length) parts.push(`anchors:\n${anchors.join('\n')}`);
  if (sourceHead) parts.push(`head:\n${sourceHead}`);
  return parts.join('\n');
}

function _getSourceLinesForNode(graph, node) {
  const cached = graph?._sourceLinesCache?.get(node.rel);
  if (cached && cached.fingerprint === (node.fingerprint || '')) {
    return cached.lines;
  }
  const text = _getSourceTextForNode(graph, node);
  const lines = text.split(/\r?\n/);
  graph?._sourceLinesCache?.set(node.rel, {
    fingerprint: node.fingerprint || '',
    lines,
  });
  return lines;
}

function _getMaskedLinesForNode(graph, node) {
  const cached = graph?._maskedLinesCache?.get(node.rel);
  if (cached && cached.fingerprint === (node.fingerprint || '')) {
    return cached.lines;
  }
  const text = _getSourceTextForNode(graph, node);
  const lines = _maskNonCodeText(text, node.lang).split(/\r?\n/);
  graph?._maskedLinesCache?.set(node.rel, {
    fingerprint: node.fingerprint || '',
    lines,
  });
  return lines;
}

function _pickCalleeDeclHit(hits, preferRel) {
  if (!hits?.length) return null;
  const sameFileDecl = preferRel ? hits.find((h) => h.rel === preferRel && h.declarationLike) : null;
  if (sameFileDecl) return sameFileDecl;
  const depthOf = (rel) => String(rel || '').split('/').length;
  const isCanonicalSrc = (rel) => /^src\//.test(rel || '');
  const sorted = [...hits].sort((a, b) =>
    Number(b.declarationLike) - Number(a.declarationLike)
    || Number(isCanonicalSrc(b.rel)) - Number(isCanonicalSrc(a.rel))
    || depthOf(a.rel) - depthOf(b.rel)
    || b.matchCount - a.matchCount
    || a.rel.localeCompare(b.rel)
    || a.line - b.line
  );
  return sorted.find((h) => h.declarationLike) || sorted[0];
}

function _resolveCalleeDeclaration(graph, name, { language = null, preferRel = null } = {}) {
  return _pickCalleeDeclHit(_findSymbolHits(graph, name, { language }), preferRel);
}

// Parallel pre-read source text for the indexed candidate files.
// Without this, _cheapReferenceSearch performs ~200 sequential
// readFileSync calls on warm-cache lookups (the in-memory text cache
// is fresh on each new process). For cross-codebase queries like
// `parseInt callers cwd=refs`, this was the dominant cost (~3-5s of
// the ~6s warm-lookup wall). Reads are dispatched concurrently via
// fs/promises so OS I/O scheduler can overlap them.
async function _prewarmReferenceSourceText(graph, symbol, language) {
  const candidateNodes = _lookupCandidateNodes(graph, symbol, language);
  if (!candidateNodes.length) return;
  const uncached = [];
  for (const node of candidateNodes) {
    const cached = graph._sourceTextCache?.get(node.rel);
    if (!cached || cached.fingerprint !== (node.fingerprint || '')) {
      uncached.push(node);
    }
  }
  if (uncached.length === 0) return;
  const { readFile } = await import('fs/promises');
  const concurrency = 64;
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= uncached.length) return;
      const node = uncached[index];
      try {
        const text = await readFile(node.abs, 'utf8');
        graph._sourceTextCache?.set(node.rel, { fingerprint: node.fingerprint || '', text });
      } catch { /* skip unreadable file */ }
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), uncached.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function _cheapReferenceSearch(graph, symbol, cwd, { language = null, limit = null, fileRel = null, scopeRelPrefix = null } = {}) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return '(no references)';
  // Include the effective cap + file scope in the cache key so a follow-up
  // call with a larger limit or a different file filter doesn't get served
  // the previously-trimmed/wide result.
  // Default `d` marks the env-default cap (REFERENCE_HIT_CAP).
  const cacheKey = `${language || '*'}|${symbol}|${Number.isFinite(limit) && limit > 0 ? String(Math.floor(limit)) : 'd'}|${fileRel || '*'}|${scopeRelPrefix || '*'}`;
  const cached = graph?._referenceSearchCache?.get(cacheKey);
  if (typeof cached === 'string') {
    return cached;
  }
  const lines = [];
  let candidateNodes = _lookupCandidateNodes(graph, symbol, language);
  if (fileRel) candidateNodes = candidateNodes.filter((node) => node.rel === fileRel);
  if (scopeRelPrefix) candidateNodes = candidateNodes.filter((node) => node.rel === scopeRelPrefix.slice(0, -1) || node.rel.startsWith(scopeRelPrefix));
  // Output cap. Default raised from 40 to 200 (HS-A5 retry showed the
  // formatter-layer cap raise was masked because the SEARCH-layer cap
  // here caps `lines` at 40 before the formatter sees them). 80 chars
  // per lineText is unchanged.
  // Per-call cap takes priority over env default so user-supplied limit
  // bounds the search loop (early break) instead of paying the full env
  // cap scan + trimming at the formatter.
  const ENV_CAP = Math.max(1, Number(process.env.REFERENCE_HIT_CAP) || 200);
  const REFERENCE_HIT_CAP = limit !== null && Number.isFinite(limit) && limit > 0
    ? Math.min(Math.max(1, Math.floor(limit)), ENV_CAP)
    : ENV_CAP;
  const REFERENCE_LINE_CAP = Math.max(20, Number(process.env.REFERENCE_LINE_CAP) || 80);
  let cappedOut = false;
  outer: for (const node of candidateNodes) {
    const sourceText = _getSourceTextForNode(graph, node);
    if (!sourceText.includes(symbol)) continue;
    const fileLines = _getMaskedLinesForNode(graph, node);
    // Masked lines are for MATCHING only (no hits inside strings/comments).
    // Display must use the RAW line: masking blanks string contents, which
    // mangles snippets containing template literals / quoted paths. Offsets
    // are preserved by the space-fill masking, so i / match.index still map.
    const rawLines = _getSourceLinesForNode(graph, node);
    for (let i = 0; i < fileLines.length; i++) {
      const line = fileLines[i];
      if (!line.trim()) continue;
      const boundaryLang = language || node.lang;
      const re = new RegExp(_unicodeBoundaryPattern(escaped, boundaryLang, symbol), 'gu');
      let match = null;
      while ((match = re.exec(line))) {
        if (lines.length < REFERENCE_HIT_CAP) {
          const trimmed = (rawLines[i] ?? line).trim().slice(0, REFERENCE_LINE_CAP);
          lines.push(`${node.rel}:${i + 1}:${match.index + 1}    ${trimmed}`);
        } else {
          // Stop as soon as the per-call cap is reached. The previous
          // 4x-cap scan was used to estimate totalHits for the
          // "+ N more" footer, but with limit propagation that estimate
          // is no longer meaningful; users who need accurate totals
          // pass a higher limit or set REFERENCE_HIT_CAP env.
          cappedOut = true;
          break outer;
        }
      }
    }
  }
  const result = lines.length ? lines.join('\n') : '(no references)';
  const finalResult = cappedOut
    ? `${result}\n\n[truncated — total hits exceeded ${REFERENCE_HIT_CAP * 4}, showing first ${REFERENCE_HIT_CAP}; raise REFERENCE_HIT_CAP env var for more]`
    : result;
  graph?._referenceSearchCache?.set(cacheKey, finalResult);
  return finalResult;
}

function _nativeEndLineForDecl(node, symbolName, declLine) {
  const symbols = Array.isArray(node?.symbols) ? node.symbols : [];
  if (!symbols.length || !symbolName) return null;
  const dl = Number(declLine);
  if (!Number.isFinite(dl)) return null;
  let exact = null;
  let nearest = null;
  let nearestDist = Infinity;
  for (const s of symbols) {
    if (!s || s.name !== symbolName) continue;
    const sl = Number(s.startLine ?? s.line);
    const el = Number(s.endLine);
    if (!Number.isFinite(sl) || !Number.isFinite(el)) continue;
    if (sl === dl && el >= dl) exact = el;
    const dist = Math.abs(sl - dl);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = el >= sl ? el : null;
    }
  }
  if (exact != null) return exact;
  return nearestDist <= 2 ? nearest : null;
}

function _formatSymbolHitLocation(hit) {
  const line = Number(hit.line);
  const col = Number(hit.col) || 1;
  const end = Number(hit.endLine);
  if (Number.isFinite(end) && end >= line) return `${hit.rel}:${line}-${end}:${col}`;
  return `${hit.rel}:${line}:${col}`;
}

function _sortSymbolHits(hits) {
  if (!hits?.length) return hits;
  const depthOf = (rel) => String(rel || '').split('/').length;
  const isCanonicalSrc = (rel) => /^src\//.test(rel || '');
  hits.sort((a, b) =>
    Number(b.declarationLike) - Number(a.declarationLike)
    || Number(isCanonicalSrc(b.rel)) - Number(isCanonicalSrc(a.rel))
    || depthOf(a.rel) - depthOf(b.rel)
    || b.matchCount - a.matchCount
    || a.rel.localeCompare(b.rel)
    || a.line - b.line
  );
  const declCount = hits.reduce((n, h) => n + (h.declarationLike ? 1 : 0), 0);
  if (declCount > 1 && hits[0]) hits[0].ambiguousDeclaration = declCount;
  return hits;
}

function _findSymbolHits(graph, symbol, { language = null } = {}) {
  const cleanSymbol = String(symbol || '').trim();
  if (!cleanSymbol) return [];
  const candidateNodes = _lookupCandidateNodes(graph, cleanSymbol, language);
  return _findSymbolHitsOnNodes(graph, cleanSymbol, candidateNodes, { language });
}

function _findSymbolHitsOnNodes(graph, cleanSymbol, candidateNodes, { language = null } = {}) {
  if (!cleanSymbol) return [];

  const escaped = cleanSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Declaration regex must anchor the symbol immediately after a
  // declaration keyword. The previous pattern (`\bkeyword\b[^\n]*\bX\b`)
  // matched ordinary callsites like `const result = doFoo(X)` as a
  // declaration of X, producing a wrong "best declaration candidate".
  // Allow optional `export [default]` / `async` modifiers and `function*`.
  // Declaration keyword set spans JS/TS, Python (def/class), Go (func/type),
  // Rust (fn/struct/enum/trait/mod), C/C++ (struct/union/typedef), C#/Java/
  // Kotlin (class/interface/record/object/struct), Ruby/PHP (def/function).
  // Restricting to only the JS/Py set was producing false "no declaration"
  // results for cross-language hits.
  const declRe = new RegExp(
    `(?:^|[\\s;{(,])(?:export\\s+(?:default\\s+)?)?(?:public\\s+|private\\s+|protected\\s+|internal\\s+|static\\s+|abstract\\s+|final\\s+|sealed\\s+|virtual\\s+|override\\s+|async\\s+|pub\\s+(?:\\([^)]*\\)\\s+)?)*(?:const|let|var|function\\*?|class|interface|type|enum|def|func|fn|struct|union|trait|impl|mod|record|object|typedef|namespace|package)\\s+${escaped}\\b`
  );
  // Assignment-style declarations: `const|let|var NAME = (…) =>` and
  // `const|let|var NAME = function`. tree-sitter often records these as a
  // variable binding the regex `declRe` already matches, but when native
  // symbols exist the regex path is gated off (see :declRe usage below), so
  // the const-arrow/const-function form was understated as `[ref]`. This
  // regex is consulted regardless of native-symbol presence so a real
  // function value bound to a name is classified `[decl]`.
  const assignDeclRe = new RegExp(
    `(?:^|[\\s;{(,])(?:export\\s+(?:default\\s+)?)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s+)?(?:function\\b|(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>)`
  );
  const hits = [];

  for (const node of candidateNodes) {
    const sourceText = _getSourceTextForNode(graph, node);
    if (!sourceText.includes(cleanSymbol)) continue;
    const boundaryLang = language || node.lang;
    const re = new RegExp(_unicodeBoundaryPattern(escaped, boundaryLang, cleanSymbol), 'gu');
    const sourceLines = _getSourceLinesForNode(graph, node);
    const lines = _getMaskedLinesForNode(graph, node);
    let firstLine = null;
    let firstCol = null;
    let matchCount = 0;
    let firstContent = '';
    let contextLines = [];
    let declarationLike = Array.isArray(node.topLevelTypes) && node.topLevelTypes.includes(cleanSymbol);
    let declLine = null;
    let declCol = null;
    let declContent = '';
    let declContext = [];
    // Native declaration lines for `cleanSymbol`, mirroring the references
    // path (_collectDeclLines / _formatCallerReferences). The regex declRe
    // cannot recognise tree-sitter method / keyword-less function decls
    // (Java/C#/C++ `[type] name(args)`), so those were mis-reported as
    // references / "no declaration". node.symbols already carries the
    // authoritative {name,line} decl records; consult it (falling back to
    // the cheap scanner only when the native graph didn't populate it).
    const hasNativeSymbols = Array.isArray(node.symbols) && node.symbols.length > 0;
    const nativeDeclLines = new Set();
    const nativeSymbolSource = hasNativeSymbols ? node.symbols : _collectCheapSymbols(sourceText, node.lang);
    for (const sym of nativeSymbolSource) {
      if (sym && sym.name === cleanSymbol) nativeDeclLines.add(sym.line);
    }
    let nativeDeclLine = null;
    let nativeDeclCol = null;
    let nativeDeclContent = '';
    let nativeDeclContext = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      re.lastIndex = 0;
      let localHit = false;
      let match = null;
      while ((match = re.exec(line))) {
        matchCount += 1;
        localHit = true;
        if (firstLine == null) {
          firstLine = i + 1;
          firstCol = match.index + 1;
          firstContent = String(sourceLines[i] || '').trim();
          contextLines = sourceLines.slice(i, i + 3).map((line) => String(line || '').trim()).filter(Boolean);
        }
        if (declLine == null && (assignDeclRe.test(line) || (!hasNativeSymbols && declRe.test(line)))) {
          declLine = i + 1;
          declCol = match.index + 1;
          declContent = String(sourceLines[i] || '').trim();
          declContext = sourceLines.slice(i, i + 3).map((l) => String(l || '').trim()).filter(Boolean);
        }
        if (nativeDeclLine == null && nativeDeclLines.has(i + 1)) {
          nativeDeclLine = i + 1;
          nativeDeclCol = match.index + 1;
          nativeDeclContent = String(sourceLines[i] || '').trim();
          nativeDeclContext = sourceLines.slice(i, i + 3).map((l) => String(l || '').trim()).filter(Boolean);
        }
      }
      if (localHit && (nativeDeclLines.has(i + 1) || assignDeclRe.test(line) || (!hasNativeSymbols && declRe.test(line)))) declarationLike = true;
    }
    if (firstLine == null) continue;
    // Prefer the native decl record over the regex-derived position when they
    // disagree: tree-sitter knows about keyword-less / method declarations the
    // regex misses, so it is the more reliable declaration reporter.
    if (nativeDeclLine != null) {
      declLine = nativeDeclLine;
      declCol = nativeDeclCol;
      declContent = nativeDeclContent;
      declContext = nativeDeclContext;
    }
    const hasDeclPos = declLine != null;
    const declLineForEnd = hasDeclPos ? declLine : firstLine;
    const endLine = _nativeEndLineForDecl(node, cleanSymbol, declLineForEnd);
    hits.push({
      rel: node.rel,
      lang: node.lang,
      line: hasDeclPos ? declLine : firstLine,
      col: hasDeclPos ? declCol : (firstCol || 1),
      ...(Number.isFinite(endLine) && endLine >= declLineForEnd ? { endLine } : {}),
      declarationLike,
      matchCount,
      content: hasDeclPos ? declContent : firstContent,
      context: hasDeclPos ? declContext : contextLines,
      firstLine,
      firstCol: firstCol || 1,
      firstContent,
      firstContext: contextLines,
    });
  }

  if (!hits.length) return [];
  return _sortSymbolHits(hits);
}

// Brace-delimited languages the callee body scanner supports. Non-brace
// languages (Python, Ruby, and the new bash/lua) get a deterministic skip
// downstream. kotlin/swift/scala ARE brace-bodied (C-style) so they stay in.
// bash uses `do`/`done`/`fi`/`}` function bodies and lua uses `function`/`end`
// — neither is `{ }`-delimited in the C sense, so both are deliberately
// omitted and fall through to the `(callees unsupported for <lang>)` skip.
// Second batch: dart/objc/zig are C-style `{ }`-bodied → included. elixir uses
// `do`/`end` blocks (not braces) → excluded like ruby. r IS brace-bodied
// (`f <- function(x) { ... }`), but it is excluded for a DIFFERENT reason than
// bash/ruby: bash/ruby are excluded as non-C-brace-body languages, whereas r IS
// C-brace-bodied — its problem is that the body scanner below only masks `//`
// and `/*` comments and does NOT understand r's `#` line comments, so a `}` or
// an unbalanced quote inside an r `#` comment would corrupt brace/quote
// tracking. r is therefore deliberately omitted and falls through to the
// `(callees unsupported for r)` skip.
const _CALLEES_BRACE_LANGS = new Set([
  'javascript', 'typescript', 'java', 'csharp', 'kotlin', 'go',
  'rust', 'c', 'cpp', 'php', 'swift', 'scala', 'dart', 'objc', 'zig',
]);

// JS/TS reserved words / syntactic keywords that look like call
// expressions but are not function invocations.
const _CALLEES_JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'return', 'yield', 'await', 'throw', 'try', 'catch', 'finally',
  'break', 'continue', 'with', 'in', 'of', 'new', 'delete', 'typeof',
  'void', 'instanceof', 'function', 'class', 'const', 'let', 'var',
  'this', 'super', 'extends', 'import', 'export', 'from', 'as',
  'static', 'async', 'true', 'false', 'null', 'undefined',
  'sizeof', 'using', 'namespace', 'interface', 'type', 'enum',
]);

// JS/TS built-in globals / constructors / namespaces. Filtered only when
// scanning JS/TS bodies so Go/Rust/etc. callees named Map/Set/parse/get
// are not suppressed.
const _CALLEES_JS_BUILTINS = new Set([
  // Constructors / wrappers
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Function',
  'Set', 'Map', 'WeakSet', 'WeakMap', 'WeakRef', 'FinalizationRegistry',
  'Promise', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Proxy',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array',
  'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  // Coercion / parsing
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI',
  'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'eval',
  'globalThis', 'NaN', 'Infinity',
  // Namespaces (called as `Math(...)` etc. is invalid but appears as
  // `Math.floor(` — bare `Math` won't match the regex but include for
  // safety against `Math` callable patterns)
  'JSON', 'Math', 'Reflect', 'Atomics', 'Intl', 'console', 'process',
  // Web / DOM globals commonly invoked
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'queueMicrotask', 'structuredClone', 'requestAnimationFrame',
  'cancelAnimationFrame', 'alert', 'confirm', 'prompt',
  // Eval-shaped / introspection
  'require',
]);

/**
 * Extract forward callees from a symbol's declaration: locate the body
 * by brace-depth scan, mask non-code text, harvest `identifier(` and
 * `obj.method(` calls, filter keywords + JS builtins, resolve each
 * callee against the graph (preferring same-file decls), and return
 * structured rows enriched for flow-tracing.
 *
 * Returns an array of `{ name, callsitePath, callsiteLine, declPath,
 * declLine, enclosing, snippet }`. `callsite*` points at the actual
 * invocation in declHit's file; `decl*` points at the callee's
 * declaration when the graph can resolve it (else empty); `enclosing`
 * is the nearest enclosing symbol at the call site.
 */
function _extractCallees(graph, declHit, _cwd, { cap = 200, callerSymbol = null, language = null } = {}) {
  if (!declHit || !_CALLEES_BRACE_LANGS.has(declHit.lang)) return [];
  const declNode = graph.nodes.get(declHit.rel);
  if (!declNode) return [];
  const sourceText = _getSourceTextForNode(graph, declNode);
  if (!sourceText) return [];

  // Fast-forward to the declaration line, then walk to the first `{`
  // outside the parameter parens. Skip braces inside comments/strings.
  // Anchor body discovery at the DECLARATION's start. Prefer the NATIVE symbol
  // record for callerSymbol over declHit's regex position: declHit.col can land
  // on an earlier same-line REFERENCE of the symbol (e.g.
  // `function a(){ if (b()){...} } function b(){...}` — the `b()` call precedes
  // `function b` on the line), which would lock body discovery onto the wrong
  // function. The native record marks the actual declaration, so call-site
  // occurrences cannot be mistaken for it. Native columns are UTF-8 byte
  // columns → converted to code units for sourceText indexing. Fall back to
  // declHit's regex line/col (already code-unit) when no native record matches.
  let declLineIdx = Math.max(0, (declHit.line || 1) - 1);
  let nativeStartCol = null;
  if (callerSymbol && Array.isArray(declNode.symbols)) {
    const rec = declNode.symbols
      .filter((s) => s && s.name === callerSymbol
        && Number.isFinite(Number(s.startLine)) && Number.isFinite(Number(s.startCol)))
      .sort((a, b) => Math.abs(Number(a.startLine) - (declHit.line || 1))
        - Math.abs(Number(b.startLine) - (declHit.line || 1)))[0];
    if (rec) {
      declLineIdx = Math.max(0, Number(rec.startLine) - 1);
      nativeStartCol = Number(rec.startCol);
    }
  }
  let i = 0;
  {
    let ln = 0;
    while (i < sourceText.length && ln < declLineIdx) {
      if (sourceText[i] === '\n') ln += 1;
      i += 1;
    }
  }
  // Declaration column in code units: from the native byte column (converted
  // against this line's text) or declHit's regex char column.
  let declColChar;
  if (nativeStartCol != null) {
    const lineEnd0 = sourceText.indexOf('\n', i);
    const lineText0 = sourceText.slice(i, lineEnd0 < 0 ? sourceText.length : lineEnd0);
    declColChar = _byteColToCharCol(lineText0, nativeStartCol);
  } else {
    declColChar = (Number.isFinite(declHit.col) && declHit.col > 1) ? declHit.col : 1;
  }
  // Advance to the declaration column (skips earlier same-line siblings /
  // references). Clamp to line end defensively.
  if (declColChar > 1) {
    const lineEnd = sourceText.indexOf('\n', i);
    const maxI = lineEnd < 0 ? sourceText.length : lineEnd;
    i = Math.min(i + (declColChar - 1), maxI);
  }
  let inLineComment = false;
  let inBlockComment = false;
  let quote = '';
  let scanI = i;
  let parenDepth = 0;
  let bodyStart = -1;
  while (scanI < sourceText.length) {
    const ch = sourceText[scanI];
    const next = sourceText[scanI + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      scanI += 1; continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; scanI += 2; continue; }
      scanI += 1; continue;
    }
    if (quote) {
      if (ch === '\\') { scanI += 2; continue; }
      if (ch === quote) { quote = ''; }
      scanI += 1; continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; scanI += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; scanI += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; scanI += 1; continue; }
    if (ch === '(') { parenDepth += 1; scanI += 1; continue; }
    if (ch === ')') { if (parenDepth > 0) parenDepth -= 1; scanI += 1; continue; }
    if (ch === '{' && parenDepth === 0) { bodyStart = scanI; break; }
    if (ch === ';' && parenDepth === 0) break;
    scanI += 1;
  }
  if (bodyStart < 0) return [];

  // Walk from bodyStart to matching `}` at depth 0.
  let depth = 0;
  let bodyEnd = -1;
  inLineComment = false; inBlockComment = false; quote = '';
  let j = bodyStart;
  while (j < sourceText.length) {
    const ch = sourceText[j];
    const next = sourceText[j + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      j += 1; continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; j += 2; continue; }
      j += 1; continue;
    }
    if (quote) {
      if (ch === '\\') { j += 2; continue; }
      if (ch === quote) { quote = ''; }
      j += 1; continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; j += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; j += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; j += 1; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { bodyEnd = j; break; }
    }
    j += 1;
  }
  if (bodyEnd < 0) bodyEnd = sourceText.length;

  const rawBody = sourceText.slice(bodyStart + 1, bodyEnd);
  const maskedBody = _maskNonCodeText(rawBody, declNode.lang);
  const bodyStartLine = sourceText.slice(0, bodyStart + 1).split('\n').length;

  // Two passes:
  //  1) Bare identifier calls — `(?<![\p{ID_Continue}$.])foo(` excludes
  //     `.`-preceded, so member-call methods are missed by this pass.
  //  2) Member-call methods — `obj.method(` / `obj?.method(`. Captures
  //     only the `method` token (the `obj.` part is identifier-bound but
  //     can be anything from a parameter to a chain). Real edges like
  //     `proc.send(`, `server.setRequestHandler(`, `emitter.on(` flow
  //     through this pass.
  const callRe = /(?<![\p{ID_Continue}$.])([\p{ID_Start}_][\p{ID_Continue}]*)(?=\s*\()/gu;
  const memberCallRe = /\.\s*\??\.?\s*([\p{ID_Start}_][\p{ID_Continue}]*)(?=\s*\()/gu;
  const seen = new Map(); // name -> { line }
  const selfName = callerSymbol || null;
  // Builtin prototype/static method names. A member call `x.method(` whose
  // method is one of these is a JS builtin (Array/String/Object/Promise/Map/
  // Set/Math/JSON/Number/EventTarget) — NOT a navigable user edge; listing it
  // adds noise and resolves to a bogus same-named decl. Applied ONLY to the
  // member-call pass so real library edges (send / on / emit /
  // setRequestHandler) survive and a bare user `parse(` / `map(` is kept.
  const _CALLEES_JS_METHODS = new Set([
    'trim','trimStart','trimEnd','slice','splice','substring','substr','split',
    'join','concat','includes','indexOf','lastIndexOf','startsWith','endsWith',
    'padStart','padEnd','repeat','charAt','charCodeAt','codePointAt','at',
    'toUpperCase','toLowerCase','normalize','match','matchAll','search',
    'replace','replaceAll','push','pop','shift','unshift','reverse','sort',
    'flat','flatMap','forEach','map','filter','every','some','reduce',
    'reduceRight','find','findIndex','findLast','findLastIndex','fill',
    'copyWithin','toString','valueOf','hasOwnProperty','keys','values',
    'entries','assign','freeze','then','catch','finally','resolve','reject',
    'all','allSettled','race','any','get','set','has','add','delete','clear',
    'max','min','floor','ceil','round','abs','sqrt','pow','log','sign','trunc',
    'random','hypot','parse','stringify','parseInt','parseFloat','isInteger',
    'isFinite','isNaN','toFixed','isArray','from','of','addEventListener',
    'removeEventListener','dispatchEvent','bind','call','apply',
  ]);
  const recordHit = (name, index, isMember) => {
    if (!name) return;
    if (_CALLEES_JS_KEYWORDS.has(name)) return;
    if (_isJsLike(declHit.lang)) {
      if (_CALLEES_JS_BUILTINS.has(name)) return;
      if (isMember && _CALLEES_JS_METHODS.has(name)) return;
    }
    if (selfName && name === selfName) return;
    if (seen.has(name)) return;
    const upto = maskedBody.slice(0, index);
    const lineInBody = upto.split('\n').length - 1;
    const absLine = bodyStartLine + lineInBody;
    // 1-based char column of the call in its physical line, for column-precise
    // enclosing resolution on same-line / minified bodies (mirrors callers).
    const absIndex = bodyStart + 1 + index;
    const lineStart = sourceText.lastIndexOf('\n', absIndex - 1) + 1;
    const charCol = absIndex - lineStart + 1;
    seen.set(name, { line: absLine, col: charCol, isMember });
  };
  let m = null;
  while ((m = callRe.exec(maskedBody))) recordHit(m[1], m.index, false);
  let mm = null;
  while ((mm = memberCallRe.exec(maskedBody))) {
    // mm.index points at the `.`; the method name itself starts after
    // the dot + optional `?` / whitespace. Use the capture-group offset
    // for line bucketing so the call-site line is precise.
    const methodStart = mm.index + mm[0].length - mm[1].length;
    recordHit(mm[1], methodStart, true);
  }
  if (seen.size === 0) return [];

  const allUnique = [...seen.entries()];
  const sliced = allUnique.slice(0, cap);
  const sourceLines = sourceText.split(/\r?\n/);
  const rows = [];
  for (const [name, info] of sliced) {
    // Resolve callee declaration via the same graph machinery used by
    // find_symbol. Precision fix: prefer a same-file declaration over
    // any cross-file same-named decl so local helpers like `fail`/`ok`
    // bind to the local copy instead of an unrelated file's symbol.
    let resolvedPath = '';
    let resolvedLine = 0;
    let resolvedDecl = false;
    try {
      const calleeDecl = _resolveCalleeDeclaration(graph, name, { language, preferRel: declHit.rel });
      // INVARIANT: only treat the callee as resolved when the graph bound it
      // to a GENUINE declaration (declarationLike). _pickCalleeDeclHit falls
      // back to sorted[0] when nothing is declaration-like, which makes Node
      // builtins / external-module names (readdirSync, join, statSync) bind to
      // whatever project file merely USES or IMPORTS the same name. Reject that
      // fallback so the row renders as external instead of a bogus decl + a
      // wasted next-hint.
      if (calleeDecl && calleeDecl.declarationLike) {
        // MEMBER calls (`x.write(`) carry no receiver identity — a same-named
        // free function elsewhere in the project (state-file.mjs `write` for
        // `process.stderr.write`) is NOT evidence of an edge. Accept the decl
        // only when it lives in the caller's own file or a file the caller
        // DIRECTLY imports. Bare calls keep name resolution as-is: their decl
        // may legitimately arrive via a re-export chain the import edge check
        // cannot see (e.g. smartReadTruncate via './tools/builtin.mjs').
        const memberOk = !info.isMember
          || calleeDecl.rel === declHit.rel
          || (Array.isArray(declNode.resolvedImports)
            && declNode.resolvedImports.some((p) => _graphRel(p, _cwd) === calleeDecl.rel));
        if (memberOk) {
          resolvedPath = calleeDecl.rel;
          resolvedLine = calleeDecl.line || 0;
          resolvedDecl = true;
        }
      }
    } catch {
      // Identifier shapes that trip the lookup regex fall through.
    }
    const snippetRaw = String(sourceLines[info.line - 1] || '').trim();
    const snippet = snippetRaw.slice(0, 80);
    // Enclosing-symbol lookup at the call site. Reuses the same
    // nearest-enclosing scanner the callers/references formatter uses
    // so flow-trace output is consistent across modes.
    let enclosing = '';
    try {
      const _encByteCol = _toByteColumn(sourceLines[info.line - 1] || '', info.col);
      const enc = _nearestEnclosingSymbol(declNode, sourceText, info.line, _encByteCol);
      enclosing = enc?.name || '';
    } catch {
      // Falls through to empty enclosing — non-fatal.
    }
    rows.push({
      name,
      callsitePath: declHit.rel,
      callsiteLine: info.line,
      declPath: resolvedPath,
      declLine: resolvedLine,
      external: !resolvedDecl,
      enclosing,
      snippet,
    });
  }
  if (allUnique.length > sliced.length) {
    rows.push({
      name: '...',
      callsitePath: '',
      callsiteLine: 0,
      declPath: '',
      declLine: 0,
      enclosing: '',
      snippet: `+${allUnique.length - sliced.length} more callees (cap=${cap})`,
      truncationFooter: true,
    });
  }
  return rows;
}

// Format a callee row for flow-traceable output. Shape:
//   `name\tcallsite <path:line>\tdecl <path:line>\t(in <enclosing>)\tnext: find_symbol({symbol:"name"})`
// `decl` collapses to `(unresolved)` when the graph could not bind the
// callee to a declaration; `(in ?)` when no enclosing symbol was found.
// When the callee could not be bound to a genuine project declaration
// (`row.external` — a Node builtin or external-module name whose only graph
// match is an import/usage of the same name), render `decl (external/builtin)`
// and OMIT the `next:` hint so the caller is not sent on a wasted find_symbol.
function _formatCalleeRow(row) {
  if (row.truncationFooter) return `... ${row.snippet}`;
  const callsite = row.callsitePath ? `callsite ${row.callsitePath}:${row.callsiteLine}` : 'callsite (unknown)';
  if (row.external) {
    const enclosingExt = row.enclosing ? `(in ${row.enclosing})` : '(in ?)';
    return `${row.name}\t${callsite}\tdecl (external/builtin)\t${enclosingExt}`;
  }
  const decl = row.declPath ? `decl ${row.declPath}:${row.declLine}` : 'decl (unresolved)';
  const enclosing = row.enclosing ? `(in ${row.enclosing})` : '(in ?)';
  const next = `next: find_symbol({symbol:"${row.name}"})`;
  return `${row.name}\t${callsite}\t${decl}\t${enclosing}\t${next}`;
}

function _keywordSymbolSortKey(symbolName, keyword) {
  const lowerName = String(symbolName || '').toLowerCase();
  const lowerKey = String(keyword || '').toLowerCase();
  const idx = lowerName.indexOf(lowerKey);
  if (idx < 0) return null;
  const atStart = idx === 0 ? 0 : 1;
  return [lowerName.length, atStart, idx, symbolName];
}

// Tokenize a search keyword on camelCase boundaries and non-alphanumeric
// separators: "capOutput" -> ["cap","output"], "smart_read" -> ["smart","read"].
function _tokenizeKeyword(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

// Token START offsets within `sym`, using the SAME boundary rules as
// _tokenizeKeyword: a token starts at string start, after any non-alphanumeric
// separator, and at a lower/digit -> Upper camelCase transition.
function _tokenStartOffsets(sym) {
  const starts = new Set();
  let prevAlnum = false;
  let prevUpper = false;
  for (let i = 0; i < sym.length; i += 1) {
    const c = sym[i];
    const isAlnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    if (!isAlnum) { prevAlnum = false; prevUpper = false; continue; }
    const isUpper = c >= 'A' && c <= 'Z';
    if (!prevAlnum) starts.add(i);            // string start / after separator
    else if (isUpper && !prevUpper) starts.add(i); // camelCase boundary
    prevAlnum = true;
    prevUpper = isUpper;
  }
  return starts;
}

// True when `lowerKey` occurs in `sym` as a TOKEN-ALIGNED contiguous substring:
// some occurrence either starts at a token boundary, or lies entirely within a
// single token (no token boundary strictly inside the matched span). This
// rejects raw substring noise that crosses a camelCase boundary — e.g. keyword
// "redact" inside "sharedActual" ("sha|red" + "act|ual") — while keeping genuine
// hits like "redact" in "redactString" or a within-token partial like "edact"
// in "redactString".
function _contiguousMatchTokenAligned(sym, lowerKey) {
  const len = lowerKey.length;
  if (!len) return false;
  const symLower = sym.toLowerCase();
  const starts = _tokenStartOffsets(sym);
  // Align on the first ALPHANUMERIC char of the match: a keyword may carry
  // leading separators (e.g. "_redact") that _tokenStartOffsets does not count
  // as token starts, so the boundary check must skip past them.
  let lead = 0;
  while (lead < len) {
    const c = lowerKey[lead];
    const isAlnum = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    if (isAlnum) break;
    lead += 1;
  }
  let from = 0;
  for (;;) {
    const idx = symLower.indexOf(lowerKey, from);
    if (idx < 0) return false;
    const end = idx + len;
    const effectiveIdx = idx + lead;
    if (starts.has(effectiveIdx)) return true;
    let interiorBoundary = false;
    for (const s of starts) {
      if (s > effectiveIdx && s < end) { interiorBoundary = true; break; }
    }
    if (!interiorBoundary) return true; // wholly inside one token
    from = idx + 1;
  }
}

// Ordered multi-token match: every token must appear in sequence (each after
// the previous match end) inside symLower. This is a deliberate widening of the
// keyword-match semantics — NOT an error-recovery fallback — so a keyword that
// drops a middle camelCase token ("capOutput") still resolves the full symbol
// ("capToolOutput", where "capoutput" is not a contiguous substring). The
// caller applies the precise contiguous includes() check first and only reaches
// this for multi-token keywords, which bounds false positives.
function _orderedTokenMatch(symLower, tokens) {
  let from = 0;
  for (const t of tokens) {
    const i = symLower.indexOf(t, from);
    if (i < 0) return false;
    from = i + t.length;
  }
  return true;
}

function _collectKeywordSymbolNames(graph, keyword, { language = null } = {}) {
  _ensureSymbolTokenIndex(graph);
  const lowerKey = String(keyword || '').toLowerCase();
  if (!lowerKey) return [];
  const keyTokens = _tokenizeKeyword(keyword);
  const seen = new Set();
  const out = [];
  const index = graph?._symbolTokenIndex;
  if (!index) return out;
  for (const key of index.keys()) {
    if (!key.startsWith('*|')) continue;
    const sym = key.slice(2);
    if (!sym || seen.has(sym)) continue;
    const symLower = sym.toLowerCase();
    // Tighten the contiguous check: a raw substring that crosses a camelCase
    // boundary (keyword "redact" inside "sharedActual" = "sha|red"+"act|ual")
    // is noise, not a real match. Require the contiguous hit to be
    // token-aligned; only then fall back to the ordered multi-token widening
    // (multi-token keywords only, to keep single-token searches tight).
    if (!_contiguousMatchTokenAligned(sym, lowerKey)) {
      if (keyTokens.length < 2 || !_orderedTokenMatch(symLower, keyTokens)) continue;
    }
    if (language) {
      const langKey = `${language}|${sym}`;
      if (!index.has(langKey)) continue;
    }
    seen.add(sym);
    out.push(sym);
  }
  out.sort((a, b) => {
    const ka = _keywordSymbolSortKey(a, keyword);
    const kb = _keywordSymbolSortKey(b, keyword);
    // Contiguous matches (non-null key) always rank before token-only matches
    // (null key) so cap=N never hides a better contiguous hit behind a loose
    // camelCase-token match.
    if (ka && !kb) return -1;
    if (!ka && kb) return 1;
    if (!ka && !kb) return a.localeCompare(b);
    for (let i = 0; i < 3; i += 1) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return a.localeCompare(b);
  });
  return out;
}

function _keywordMatchesSymbolName(name, lowerKey, keyTokens) {
  const sym = String(name || '').trim();
  if (!sym || !lowerKey) return false;
  if (_contiguousMatchTokenAligned(sym, lowerKey)) return true;
  return keyTokens.length >= 2 && _orderedTokenMatch(sym.toLowerCase(), keyTokens);
}

function _nativeSymbolHit(node, sym) {
  const line = Number(sym?.line ?? sym?.startLine);
  if (!Number.isFinite(line) || line < 1) return null;
  const endLine = Number(sym?.endLine);
  return {
    rel: node.rel,
    lang: node.lang,
    line,
    col: Number(sym?.startCol) || Number(sym?.col) || 1,
    endLine: Number.isFinite(endLine) && endLine >= line ? endLine : null,
    declarationLike: true,
    matchCount: 1,
    content: '',
    context: [],
  };
}

function _collectNativeKeywordSymbolEntries(graph, keyword, { language = null } = {}) {
  const lowerKey = String(keyword || '').toLowerCase();
  if (!lowerKey) return [];
  const keyTokens = _tokenizeKeyword(keyword);
  const byName = new Map();
  for (const node of graph?.nodes?.values?.() || []) {
    if (language && node.lang !== language) continue;
    const symbols = Array.isArray(node?.symbols) ? node.symbols : [];
    if (!symbols.length) continue;
    for (const sym of symbols) {
      const name = String(sym?.name || '').trim();
      if (!_keywordMatchesSymbolName(name, lowerKey, keyTokens)) continue;
      const hit = _nativeSymbolHit(node, sym);
      if (!hit) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(hit);
    }
  }
  const entries = [];
  for (const [name, hits] of byName.entries()) {
    const sorted = _sortSymbolHits(hits);
    entries.push({
      name,
      hit: _pickCalleeDeclHit(sorted) || sorted[0] || null,
      resolved: sorted.length > 0,
    });
  }
  entries.sort((a, b) => {
    const ka = _keywordSymbolSortKey(a.name, keyword);
    const kb = _keywordSymbolSortKey(b.name, keyword);
    if (ka && !kb) return -1;
    if (!ka && kb) return 1;
    if (!ka && !kb) return a.name.localeCompare(b.name);
    for (let i = 0; i < 3; i += 1) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function _collectCheapKeywordSymbolEntries(graph, keyword, { language = null } = {}) {
  const lowerKey = String(keyword || '').toLowerCase();
  if (!lowerKey) return [];
  const keyTokens = _tokenizeKeyword(keyword);
  const entries = [];
  for (const node of graph?.nodes?.values?.() || []) {
    if (language && node.lang !== language) continue;
    if (Array.isArray(node?.symbols) && node.symbols.length) continue;
    const sourceText = _getSourceTextForNode(graph, node);
    for (const sym of _collectCheapSymbols(sourceText, node.lang)) {
      const name = String(sym?.name || '').trim();
      if (!_keywordMatchesSymbolName(name, lowerKey, keyTokens)) continue;
      const hit = _nativeSymbolHit(node, sym);
      if (!hit) continue;
      entries.push({ name, hit, resolved: true });
    }
  }
  return entries;
}

function _formatSearchSymbolRow(name, hit) {
  const loc = hit ? _formatSymbolHitLocation(hit) : '(unresolved)';
  const next = `next: find_symbol({symbol:"${name}"})`;
  return `${name}\t${loc}\t${next}`;
}

function _searchSymbolsByKeyword(graph, keyword, cwd, { language = null, limit = 30 } = {}) {
  const clean = String(keyword || '').trim();
  if (!clean) return '(no keyword)';
  const cap = Math.max(1, Math.min(100, Math.floor(Number(limit) || 30)));
  const nativeEntries = _collectNativeKeywordSymbolEntries(graph, clean, { language });
  const cheapEntries = _collectCheapKeywordSymbolEntries(graph, clean, { language });
  const entries = [...nativeEntries, ...cheapEntries];
  if (!entries.length) {
    const nodeCount = graph?.nodes?.size ?? 0;
    return `(no symbol keyword matches in cwd=${cwd})\ngraph: nodes=${nodeCount}${language ? `, language=${language}` : ''}`;
  }
  entries.sort((a, b) => {
    const rank = Number(b.resolved) - Number(a.resolved);
    if (rank !== 0) return rank;
    const ka = _keywordSymbolSortKey(a.name, keyword);
    const kb = _keywordSymbolSortKey(b.name, keyword);
    // Contiguous matches rank before token-only matches (see _collectKeywordSymbolNames).
    if (ka && !kb) return -1;
    if (!ka && kb) return 1;
    if (!ka && !kb) return a.name.localeCompare(b.name);
    for (let i = 0; i < 3; i += 1) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return a.name.localeCompare(b.name);
  });
  const resolvedEntries = entries.filter((e) => e.resolved);
  const unresolvedNames = entries.filter((e) => !e.resolved).map((e) => e.name);
  const shownResolved = resolvedEntries.slice(0, cap);
  const lines = [`# search keyword=${clean} matches=${entries.length} shown=${shownResolved.length}`];
  for (const { name, hit } of shownResolved) {
    lines.push(_formatSearchSymbolRow(name, hit));
  }
  if (resolvedEntries.length > shownResolved.length) {
    lines.push(`...+${resolvedEntries.length - shownResolved.length} more resolved (cap=${cap})`);
  }
  if (unresolvedNames.length) {
    lines.push(`+${unresolvedNames.length} unresolved name variants (token-only, no declaration — find_symbol will miss these; grep to locate): ${unresolvedNames.join(', ')}`);
  }
  if (graph?.truncated) {
    lines.push(`WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — matches may be incomplete. Re-run with a narrower cwd.`);
  }
  return lines.join('\n');
}

function _findSymbolAcrossGraph(graph, symbol, cwd, { language = null, limit = 5, fileRel = null, body = true } = {}) {
  // Caller-supplied `language` is a hard scope: never widen to other
  // languages on miss. Returning a different-language hit was producing
  // misleading results when callers wanted strict language-narrowed
  // analysis.
  const allHits = _findSymbolHits(graph, symbol, { language });
  // SCOPE ISOLATION: when `file` is set, the caller wants this file's
  // declaration + refs only — not every same-named symbol across other
  // files. Filter rather than widen.
  const hits = fileRel ? allHits.filter((h) => h.rel === fileRel) : allHits;

  if (!hits.length) {
    // Silent (no match) was burning iters — caller had no signal whether to retry
    // with a different cwd or accept the miss. Surface graph stats + actionable hint.
    const nodeCount = graph?.nodes?.size ?? 0;
    const scopeNote = fileRel ? ` file=${fileRel}` : '';
    const lines = [`(no symbol matches in cwd=${cwd}${scopeNote})`];
    lines.push(`graph: nodes=${nodeCount}${language ? `, language=${language}` : ''}`);
    if (graph?.truncated) {
      lines.push(`WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — symbol may exist in an un-indexed file. Re-run with a narrower cwd.`);
    }
    // Case-insensitive "did you mean" scan over the symbol token index. Catches
    // common typos (callworker → callWorker) without forcing a paraphrased retry.
    const lowerSym = symbol.toLowerCase();
    const ciHits = [];
    if (graph?._symbolTokenIndex && nodeCount > 0) {
      for (const key of graph._symbolTokenIndex.keys()) {
        const idx = key.indexOf('|');
        if (idx < 0) continue;
        const symPart = key.slice(idx + 1);
        if (symPart !== symbol && symPart.toLowerCase() === lowerSym) {
          if (!ciHits.includes(symPart)) ciHits.push(symPart);
          if (ciHits.length >= 3) break;
        }
      }
    }
    return lines.join('\n');
  }

  const topHits = hits.slice(0, Math.max(1, limit));
  const primary = topHits[0];
  const declHits = hits.filter((h) => h.declarationLike);
  const declCount = declHits.length;
  const lines = [];
  // Ambiguity guard: with 2+ genuine declarations of the same name, a caller
  // acting on the "best candidate" alone may patch the wrong definition.
  // Prepend an explicit warning listing every declaration's file:line.
  if (declCount > 1) {
    lines.push(`⚠ ${declCount} declarations found — verify which one you intend`);
    for (const h of declHits) lines.push(`  ${_formatSymbolHitLocation(h)} [${h.lang}]`);
    lines.push('');
  }
  if (primary?.declarationLike) {
    // When the graph is truncated, the "best" candidate is only best AMONG
    // indexed files — the canonical declaration may live in an un-indexed file
    // (e.g. src/** dropped past CODE_GRAPH_MAX_FILES at a huge cwd). Flag the
    // caveat inline at the prominent claim, not just the scope footer, so the
    // confident heading never reads as authoritative under truncation.
    lines.push(graph?.truncated
      ? '# best declaration candidate (GRAPH TRUNCATED — may not be canonical; re-run with a narrower cwd to confirm)'
      : '# best declaration candidate');
    const multi = declCount > 1 ? `, declarations=${declCount}` : '';
    lines.push(`${_formatSymbolHitLocation(primary)} (${primary.lang}, matches=${primary.matchCount}${multi})`);
    // body:true → emit the full declaration span (cap 300 lines) so review/debug
    // gets the function in ONE call instead of find_symbol + a follow-up read.
    // Opt-in so plain locate/callee-trace lookups stay compact.
    let bodyEmitted = false;
    if (body === true && Number.isFinite(Number(primary.line))) {
      const node = graph.nodes.get(primary.rel);
      const srcText = node ? _getSourceTextForNode(graph, node) : null;
      if (srcText) {
        const all = srcText.split('\n');
        const start = Math.max(1, Number(primary.line));
        let end = Number(primary.endLine);
        // Assignment-style declarations (`const f = (…) => {`) carry no
        // endLine in the graph; falling back to the bare declaration line
        // emits a 1-line body. Recover the span from indentation first.
        if (!Number.isFinite(end) || end < start) {
          end = _inferSpanEndByIndent(all, start) ?? start;
        }
        end = Math.min(end, start + 299);
        // Large bodies (up to the 300-line cap) flood context when the caller
        // only needed location+callees, so above a threshold emit head+tail with
        // an elision marker; small spans stay whole to keep the one-call utility.
        const BODY_FULL_MAX = 120; // spans ≤ this emit verbatim
        const BODY_HEAD = 90;      // leading lines kept when eliding
        const BODY_TAIL = 20;      // trailing lines kept when eliding
        const fmt = (i) => `${start + i}: ${all[start - 1 + i]}`;
        const span = end - start + 1;
        if (span > BODY_FULL_MAX) {
          const head = Array.from({ length: BODY_HEAD }, (_, i) => fmt(i));
          const tail = Array.from({ length: BODY_TAIL }, (_, i) => fmt(span - BODY_TAIL + i));
          const elided = span - BODY_HEAD - BODY_TAIL;
          head.push(`... [${elided} lines elided — full body: read ${primary.rel} symbol=${symbol}]`);
          lines.push([...head, ...tail].join('\n'));
        } else {
          lines.push(all.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n'));
        }
        bodyEmitted = true;
      }
    }
    if (!bodyEmitted) {
      if (primary.content) lines.push(primary.content.slice(0, 100));
      if (Array.isArray(primary.context) && primary.context.length > 1) {
        lines.push(`context: ${primary.context.slice(0, 2).join(' | ').slice(0, 120)}`);
      }
    }
    if (declCount > 1) {
      const others = declHits.slice(1, 3).map((h) => `${_formatSymbolHitLocation(h)} [${h.lang}]`);
      if (others.length) lines.push(`other declarations: ${others.join(', ')}`);
    }
    lines.push('');
  }
  lines.push('# candidates');
  lines.push(...topHits.map((hit, idx) => {
    const kind = hit.declarationLike ? 'decl' : 'ref';
    const suffix = hit.content ? ` — ${hit.content.slice(0, 100)}` : '';
    return `${idx + 1}. ${_formatSymbolHitLocation(hit)} [${kind}, ${hit.lang}, matches=${hit.matchCount}]${suffix}`;
  }));
  // BUILTIN-COLLISION NOTE: every hit is a `[ref]` with no `[decl]` —
  // surface that the user has no declaration of this name so the caller
  // can stop hunting for one (e.g. global `fetch`/`read`/`console`).
  if (declCount === 0 && hits.length > 0) {
    lines.push('');
    lines.push(`(no user declaration found; likely a global/builtin identifier — all ${hits.length} hits are references)`);
  }
  // STRUCTURAL FORWARD GRAPH: append the symbol's callees inline so a
  // single `find_symbol({symbol})` returns declaration + what it calls.
  // Unconditional — no query-type branch, no opt-in flag. The cap is
  // smaller than the explicit `callees` mode (which uses 200) to keep
  // the declaration response compact.
  if (primary?.declarationLike) {
    const calleeRows = _extractCallees(graph, primary, cwd, {
      cap: 25,
      callerSymbol: symbol,
      language,
    });
    lines.push('');
    lines.push('# callees');
    if (calleeRows.length) {
      for (const row of calleeRows) {
        lines.push(_formatCalleeRow(row));
      }
    } else {
      lines.push('(no callees)');
    }
  }
  // Footer: surface active scope so the caller sees which graph answered.
  // Reduces "looks fine, but is this the right project?" doubt and the
  // wrong-cwd retry that follows when the answer was from an unintended tree.
  const _nodeCount = graph?.nodes?.size ?? 0;
  const truncatedSuffix = graph?.truncated
    ? ` [WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — some files not indexed]`
    : '';
  const fileScopeSuffix = fileRel ? ` file=${fileRel}` : '';
  lines.push(`\n# scope: cwd=${cwd} graph=${_nodeCount}-nodes${language ? ` language=${language}` : ''}${fileScopeSuffix}${truncatedSuffix}`);
  return lines.join('\n');
}

function _resolveReferenceLanguageNode(graph, symbol, rel, cwd, language = null) {
  if (rel) {
    const node = graph.nodes.get(rel);
    if (!node) {
      // Path was supplied but the graph never indexed it (typo,
      // unsupported extension, or outside cwd). Distinct from the
      // "indexed-but-symbol-absent" miss below so callers can render
      // a precise error instead of the generic "file not found".
      return { kind: 'file-not-found', node: null, file: rel };
    }
    // P0: verify the symbol actually appears in the file. Returning a
    // node solely because the path was indexed was producing language
    // bleed: a caller asking for `references(symbol=Foo, file=bar.py)`
    // would get bar.py's language even when Foo never appears in it,
    // narrowing the broader reference search to the wrong language.
    const tokens = _getTokenSymbolsForNode(graph, node);
    if (Array.isArray(tokens) && tokens.includes(String(symbol || ''))) {
      return { kind: 'ok', node, file: rel };
    }
    // Fallback: substring scan over source for non-identifier shapes
    // (e.g. method calls on values whose tokenSymbols misses the name).
    const text = _getSourceTextForNode(graph, node);
    if (typeof text === 'string' && text.includes(String(symbol || ''))) {
      return { kind: 'ok', node, file: rel };
    }
    return { kind: 'symbol-not-present', node: null, file: rel };
  }
  const hits = _findSymbolHits(graph, symbol, { language });
  // Caller-specified language is a hard filter — refuse to widen on miss so
  // a `language: 'python'` query never bleeds into TS/JS results.
  if (!hits.length) return { kind: 'symbol-not-present', node: null, file: null };
  const primary = hits.find((hit) => hit.declarationLike) || hits[0];
  const node = primary?.rel ? graph.nodes.get(primary.rel) || null : null;
  return node
    ? { kind: 'ok', node, file: node.rel }
    : { kind: 'symbol-not-present', node: null, file: null };
}

function _referenceKind(line, symbol, lang = null) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return 'reference';
  const text = String(line || '');
  // Declaration keywords across every language _collectCheapSymbols supports
  // (JS/TS, Python, Go, Rust, Java/Kotlin/C#, C/C++, Ruby/PHP). A line where
  // any of these introduce the target symbol is the declaration site itself,
  // not a call site, and must be excluded from find_callers. JS-only keywords
  // previously caused Python `def`, Go `func`, Rust `fn`, Kotlin `fun`,
  // C/C++ `struct/union/typedef`, Ruby `module` declaration lines to be
  // classified as `call` (self-match), making caller counts inconsistent
  // across languages.
  if (new RegExp(
    `\\b(?:` +
      // type-like declarations
      `function|class|interface|type|enum|record|struct|union` +
      // scope-like declarations
      `|namespace|module|package|trait|impl|object` +
      // binding declarations
      `|const|let|var|val|typedef` +
      // single-word function declarations
      `|def|fn|fun` +
    `)\\s+${escaped}\\b`,
  ).test(text)) return 'declaration';
  // Go `func name(...)` or `func (recv) name(...)` with optional receiver.
  if (new RegExp(`\\bfunc(?:\\s*\\([^)]*\\))?\\s+${escaped}\\b`).test(text)) return 'declaration';
  if (new RegExp(`\\bimport\\b[\\s\\S]*${_unicodeBoundaryPattern(escaped, lang, symbol)}`, 'u').test(text)) return 'import';
  if (new RegExp(`${_unicodeBoundaryPattern(escaped, lang, symbol)}\\s*\\(`, 'u').test(text)) return 'call';
  return 'reference';
}

// Convert a 1-based UTF-16 char column (the reference scanner emits
// `match.index + 1`, a JS string index) into a 1-based UTF-8 byte column,
// matching the native symbol's tree-sitter byte columns. Without this, a
// same-line non-ASCII prefix before a declaration misaligns JS code-unit
// columns against native byte columns and could exclude the correct sibling.
function _toByteColumn(lineText, charCol) {
  if (!Number.isFinite(charCol) || charCol < 1) return charCol;
  const prefix = String(lineText || '').slice(0, charCol - 1);
  return Buffer.byteLength(prefix, 'utf8') + 1;
}

// Inverse of _toByteColumn: a 1-based UTF-8 byte column (as emitted by the
// native tree-sitter symbol records) back to a 1-based UTF-16 code-unit column
// for indexing into a JS string. Walks codepoints so surrogate pairs (e.g.
// emoji) advance the code-unit index by 2 while counting their real byte width.
function _byteColToCharCol(lineText, byteCol) {
  if (!Number.isFinite(byteCol) || byteCol < 1) return 1;
  const s = String(lineText || '');
  let bytes = 0;
  let k = 0;
  while (k < s.length && bytes < byteCol - 1) {
    const cp = s.codePointAt(k);
    bytes += Buffer.byteLength(String.fromCodePoint(cp), 'utf8');
    k += cp > 0xFFFF ? 2 : 1;
  }
  return k + 1;
}

function _nearestEnclosingSymbol(node, sourceText, lineNumber, col = null) {
  // SINGLE SOURCE OF TRUTH: the native graph's per-symbol records, each with a
  // finite endLine. The cheap regex scanner is intentionally NOT consulted for
  // enclosing resolution — its loose `name(args){` shapes carry no end-of-body
  // span, so using them would reintroduce the endLine-less nearest-declaration
  // mis-attribution this fix removes (the `caller=_pfAbsPath` class). A file
  // whose language the native binary does not extract symbols for yields no
  // candidates and resolves to null (no enclosing symbol) rather than a guess.
  // (kotlin/swift ARE natively extracted now, so they are no longer examples
  // of the no-extraction case.)
  const FUNCTION_LIKE = new Set([
    'function', 'method', 'arrow', 'class', 'generator', 'fn', 'async-function',
    // Body-bearing constructs whose kinds come from the native extractor:
    // constructor_declaration -> 'constructor', local_function_statement ->
    // 'local-function', record_declaration -> 'record'.
    'constructor', 'record', 'local-function',
  ]);
  const symbols = Array.isArray(node?.symbols) ? node.symbols : [];
  // Body-span containment by [line, endLine]. When the call-site column is
  // known, refine the SAME-LINE boundaries with it so multiple declarations
  // sharing one physical line (minified / compact code) are disambiguated: a
  // decl that opens after the call column on its start line, or closes before
  // the call column on its end line, is excluded. Column is consulted ONLY on
  // the boundary line(s); ordinary multi-line code is judged exactly as before
  // (line range only) — no regression. Columns are 1-based to match the
  // reference scanner's `match.index + 1`.
  const inRange = (item) => {
    if (item.line > lineNumber || Number(item.endLine) < lineNumber) return false;
    if (col != null) {
      const sl = Number(item.startLine);
      const sc = Number(item.startCol);
      const ec = Number(item.endCol);
      if (Number.isFinite(sl) && sl === lineNumber && Number.isFinite(sc) && col < sc) return false;
      if (Number(item.endLine) === lineNumber && Number.isFinite(ec) && col > ec) return false;
    }
    return true;
  };
  // Nearest enclosing wins: latest start line, then rightmost start column on a
  // tie (innermost of same-line siblings). Prefer a function-like; else the
  // nearest containing symbol of any kind; else null (no enclosing symbol).
  const candidates = symbols
    .filter(inRange)
    .sort((a, b) => (b.line - a.line) || ((Number(b.startCol) || 0) - (Number(a.startCol) || 0)));
  const fn = candidates.find((item) => FUNCTION_LIKE.has(String(item.kind || '').toLowerCase()));
  return fn || candidates[0] || null;
}

// Raised from 40 to 200 after HS-A5 surfaced that callers on a cross-
// codebase symbol (`parseInt` across refs/) silently truncated at 40
// callers, hiding all codex/ and warp/ matches. tail-trim still bounds
// the payload; a higher cap is the invariant-correct fix vs. asking
// every caller to pass an explicit limit.
// Classify each reference of `symbol` into a structured entry
// {file,line,col, kind, caller, lineText}. `caller` is the enclosing function
// name for `call` kind (else ''). Shared by the string formatter and the
// transitive-callers walker so the latter never has to re-parse formatted text.
function _collectCallerEntries(graph, symbol, referenceText) {
  const entries = _parseReferenceEntries(referenceText);
  const detailed = [];
  // Per-file cache of declaration line numbers for `symbol`. Populated
  // lazily so files that never need the keyword-less-method fallback pay
  // nothing.
  const declLinesCache = new Map();
  for (const entry of entries) {
    const node = graph.nodes.get(entry.file);
    if (!node) continue;
    const sourceText = _getSourceTextForNode(graph, node);
    const sourceLines = sourceText.split(/\r?\n/);
    const line = String(sourceLines[entry.line - 1] || '').trim();
    if (!line) continue;
    let kind = _referenceKind(line, symbol, node.lang);
    // Keyword-less method declaration guard. The keyword-based regex in
    // _referenceKind cannot recognise Java/C#/C++ method declarations
    // shaped `[modifier] [type] name(args) [{|;]` because they introduce
    // the symbol with no declaration keyword. The cheap-symbol scanner
    // already classifies those lines as `function`/`method`/`class`, so
    // if a `call` line coincides with a cheap-symbol decl of the same
    // name, promote it to `declaration` and drop it from call sites.
    if (kind === 'call') {
      let declLines = declLinesCache.get(node.rel);
      if (!declLines) {
        declLines = new Set();
        for (const sym of (Array.isArray(node.symbols) && node.symbols.length ? node.symbols : _collectCheapSymbols(sourceText, node.lang))) {
          if (sym && sym.name === symbol) declLines.add(sym.line);
        }
        declLinesCache.set(node.rel, declLines);
      }
      if (declLines.has(entry.line)) kind = 'declaration';
    }
    const _encByteCol = _toByteColumn(sourceLines[entry.line - 1] || '', entry.col);
    const enclosing = _nearestEnclosingSymbol(node, sourceText, entry.line, _encByteCol);
    detailed.push({
      ...entry,
      kind,
      caller: kind === 'call' ? (enclosing?.name || '') : '',
      lineText: line,
    });
  }
  return detailed;
}

function _formatCallerReferences(graph, symbol, referenceText, { limit = 200 } = {}) {
  const detailed = _collectCallerEntries(graph, symbol, referenceText);
  if (!detailed.length) return '(no callers)';

  const callSites = detailed.filter((entry) => entry.kind === 'call');
  const format = (entry) => {
    const caller = entry.caller ? `\tcaller=${entry.caller}` : '';
    return `${entry.file}:${entry.line}:${entry.col}\t${entry.kind}${caller}\t${entry.lineText.slice(0, 80)}`;
  };
  if (callSites.length) {
    const total = callSites.length;
    const head = callSites.slice(0, limit).map(format);
    const overflow = total > limit ? [`... +${total - limit} more call sites`] : [];
    return ['# call sites', ...head, ...overflow].join('\n');
  }

  const NON_CALL_CAP = 40;
  const nonCallEntries = detailed.slice(0, NON_CALL_CAP);
  const overflow = detailed.length > NON_CALL_CAP
    ? `\n... +${detailed.length - NON_CALL_CAP} more non-call references`
    : '';
  return [
    '(no call sites)',
    nonCallEntries.length ? `# non-call references\n${nonCallEntries.map(format).join('\n')}${overflow}` : '',
  ].filter(Boolean).join('\n');
}

// Distinct enclosing-function names that call `symbol` (the recursion frontier
// for transitive callers). Reads STRUCTURED entries (not formatted text), so a
// stray "caller=" inside raw source lineText can never be misread as a caller.
// Name-based, like callers mode.
function _callerNamesOf(graph, symbol, cwd, language) {
  const refs = _cheapReferenceSearch(graph, symbol, cwd, { language });
  // Named callers (recursable), keyed by name → first call-site location, so
  // the transitive tree annotates each node with `file:line` and a consumer
  // need not re-grep/read to find where it lives.
  const byName = new Map();
  // Anonymous call sites — invocations whose enclosing context has no named
  // function: setInterval/timer callbacks, event handlers (`backend.onMessage`
  // = arrow), module top-level boot blocks, fs.watch callbacks. They have no
  // name to recurse through, so the old name-only walk DROPPED them — yet they
  // are exactly the entry points a thorough consumer then greps for. Surface
  // each as a terminal leaf (keyed by location, labelled with its call-site
  // source line) so the tree is genuinely complete and the chase stops.
  const leaves = new Map();
  for (const e of _collectCallerEntries(graph, symbol, refs)) {
    if (e.kind !== 'call') continue;
    if (e.caller && e.caller !== symbol) {
      if (!byName.has(e.caller)) byName.set(e.caller, { name: e.caller, loc: `${e.file}:${e.line}`, leaf: false });
    } else if (!e.caller) {
      const loc = `${e.file}:${e.line}`;
      if (!leaves.has(loc)) {
        const snippet = String(e.lineText || 'call').replace(/\s+/g, ' ').trim().slice(0, 48);
        leaves.set(loc, { name: `«${snippet}»`, loc, leaf: true });
      }
    }
  }
  // Hub guard: a symbol with MANY anonymous call sites is a generic hub
  // (e.g. handleToolCall, called from test scripts + cross-module dispatch) —
  // listing them is noise, not entry points. Surface anonymous leaves only
  // when there are few enough to be this symbol's distinctive entry set
  // (timer/event/boot triggers); above the threshold, drop them all.
  const ANON_LEAF_MAX = 6;
  const leafList = leaves.size <= ANON_LEAF_MAX ? [...leaves.values()] : [];
  return [...byName.values(), ...leafList];
}

// Transitive upstream caller TREE: BFS over enclosing-function names up to
// `depth` levels, returned as an indented tree in ONE call (replaces the
// manual per-level callers batching). NAME-BASED like callers mode — two
// different functions sharing a name are merged, so this is an upstream-chain
// OVERVIEW, not a precise per-declaration graph. Bounded by nodeCap; a symbol
// whose callers were already listed is shown once and marked (shared-caller /
// cycle guard) so the payload can't blow up.
function _formatTransitiveCallers(graph, rootSymbol, cwd, { language = null, depth = 2, pageSize = 100, page = 1, hardMax = 1000 } = {}) {
  // Walk the whole transitive tree ONCE into a flat, ordered list of
  // { indent, label } entries (cycle-guarded; bounded by hardMax as an
  // anti-runaway ceiling), then PAGINATE that list `pageSize` nodes at a time.
  // Pagination beats a hard node cap: an oversized tree is no longer truncated
  // into an incomplete "go grep the rest" state — the consumer just asks for
  // page:N+1 and stays inside code_graph.
  const expanded = new Set();
  const collected = [];
  let overflow = false;
  const walk = (symbol, level) => {
    if (overflow || level >= depth) return;
    if (expanded.has(symbol)) {
      collected.push({ indent: level + 1, label: `${symbol} … (callers expanded above)` });
      return;
    }
    expanded.add(symbol);
    for (const entry of _callerNamesOf(graph, symbol, cwd, language)) {
      if (collected.length >= hardMax) { overflow = true; return; }
      // Each node carries its call-site file:line so the tree is
      // self-sufficient — no per-node re-grep/read needed to locate it.
      collected.push({ indent: level + 1, label: `${entry.name}\t${entry.loc}` });
      // Leaves are anonymous call sites (timer/event/boot) with no name to
      // walk through — terminal by construction.
      if (!entry.leaf) walk(entry.name, level + 1);
    }
  };
  walk(rootSymbol, 0);
  if (collected.length === 0) return _augmentNoHitDiagnostic('(no callers)', '(no callers)', graph, cwd, rootSymbol);

  const size = Math.max(1, Math.floor(Number(pageSize) || 100));
  const pg = Math.max(1, Math.floor(Number(page) || 1));
  const total = collected.length;
  const lastPage = Math.ceil(total / size);
  const start = (pg - 1) * size;
  if (start >= total) {
    return `# transitive callers of ${rootSymbol} (depth=${depth}) — page ${pg} is past the end (total ${total}${overflow ? '+' : ''} node(s); last page is ${lastPage}).`;
  }
  const slice = collected.slice(start, start + size);
  const hasMore = overflow || (start + slice.length) < total;
  const lines = [
    `# transitive callers of ${rootSymbol} (depth=${depth}) — page ${pg}, nodes ${start + 1}-${start + slice.length} of ${total}${overflow ? '+' : ''}; INDENTED children are ITS callers`,
    rootSymbol,
    ...slice.map((e) => `${'  '.repeat(e.indent)}${e.label}`),
  ];
  if (hasMore) {
    // More nodes remain — steer the continuation into the SAME tool (next
    // page), never a grep/read sweep.
    lines.push(`# NEXT — more callers remain; re-run callers with the SAME symbol + depth + page:${pg + 1} for the next ${size} node(s). Every node carries file:line — do NOT grep/read.`);
  } else {
    // Final page reached: the full transitive set has now been delivered.
    lines.push(`# END — complete caller set delivered (page ${pg} of ${lastPage}): named callers PLUS timer/event/module-level call sites (the «…» leaves), each with file:line. No further callers/grep/read is needed.`);
  }
  return lines.join('\n');
}

function _parseReferenceEntries(referenceText) {
  if (typeof referenceText !== 'string' || !referenceText.trim() || referenceText === '(no references)') {
    return [];
  }
  const out = [];
  for (const line of referenceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(.+?):(\d+):(\d+)(?:[\s\t]+(.*))?$/.exec(trimmed);
    if (!m) continue;
    out.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      text: m[4] ? m[4].trim() : '',
    });
  }
  return out;
}

function _formatSymbolImpactLine(item) {
  const callerSuffix = item.callers.length ? ` -> ${item.callers.join(', ')}` : '';
  return `${item.symbol}\trefs=${item.references}\tcallers=${item.callers.length}${callerSuffix}`;
}

function _collectImpactSymbols(node, graph) {
  const names = new Set();
  for (const typeName of Array.isArray(node?.topLevelTypes) ? node.topLevelTypes : []) names.add(typeName);
  const text = _getSourceTextForNode(graph, node);
  for (const item of _collectCheapSymbols(text, node.lang)) names.add(item.name);
  return [...names];
}

function _buildImpactSummary(node, graph, cwd, targetSymbol = '') {
  const imports = node.resolvedImports.map((p) => _graphRel(p, cwd));
  const dependents = [...(graph.reverse.get(node.rel) || [])].sort();
  const related = [...new Set([...imports, ...dependents])].sort();
  const symbols = targetSymbol ? [targetSymbol] : _collectImpactSymbols(node, graph).slice(0, 8);
  const symbolImpact = [];
  const externalCallers = new Set();
  let externalReferences = 0;
  for (const symbol of symbols) {
    const refs = _parseReferenceEntries(_cheapReferenceSearch(graph, symbol, cwd, { language: node.lang }))
      .filter((entry) => entry.file !== node.rel);
    if (refs.length === 0) continue;
    const callers = [...new Set(refs.map((entry) => entry.file))].sort();
    for (const caller of callers) externalCallers.add(caller);
    externalReferences += refs.length;
    symbolImpact.push({
      symbol,
      references: refs.length,
      callers,
    });
  }
  symbolImpact.sort((a, b) => (b.references - a.references) || a.symbol.localeCompare(b.symbol));
  return {
    imports,
    dependents,
    related,
    symbolImpact,
    externalCallers: [...externalCallers].sort(),
    externalReferences,
    scannedSymbols: symbols.length,
  };
}

// Bound model-facing structural list output (imports/dependents/related,
// symbols, external callers) so a high fan-in/fan-out or symbol-dense file
// cannot inject an unbounded result — mirrors the find_imports/find_dependents
// cap. Function declaration is hoisted, so callers earlier in the file resolve.
function _capGraphList(arr, cap = 200) {
  return arr.length > cap
    ? [...arr.slice(0, cap), `[truncated — showing first ${cap} of ${arr.length}]`]
    : arr;
}

function _formatRelated(node, graph, cwd) {
  const imports = node.resolvedImports.map((p) => _graphRel(p, cwd));
  const dependents = [...(graph.reverse.get(node.rel) || [])].sort();
  const related = [...new Set([...imports, ...dependents])].sort();
  // Align with `impact` mode's schema: emit summary counts + the related
  // array so callers reading either mode see consistent header fields
  // (file/language/imports/dependents/related) before the bodies.
  const lines = [
    `file\t${node.rel}`,
    `language\t${node.lang}`,
    `imports\t${imports.length}`,
    `dependents\t${dependents.length}`,
    `related\t${related.length}`,
  ];
  lines.push('');
  lines.push('# imports');
  lines.push(imports.length ? _capGraphList(imports).join('\n') : '(none)');
  lines.push('');
  lines.push('# dependents');
  lines.push(dependents.length ? _capGraphList(dependents).join('\n') : '(none)');
  if (related.length) {
    lines.push('');
    lines.push('# related');
    lines.push(..._capGraphList(related));
  }
  return lines.join('\n');
}

function _formatImpact(node, graph, cwd, targetSymbol = '') {
  const summary = _buildImpactSummary(node, graph, cwd, targetSymbol);
  const lines = [
    `file\t${node.rel}`,
    `language\t${node.lang}`,
    `imports\t${summary.imports.length}`,
    `dependents\t${summary.dependents.length}`,
    `related\t${summary.related.length}`,
    `scanned_symbols\t${summary.scannedSymbols}`,
    `external_references\t${summary.externalReferences}`,
    `external_callers\t${summary.externalCallers.length}`,
  ];
  if (targetSymbol) lines.push(`symbol\t${targetSymbol}`);
  if (summary.related.length) {
    lines.push('');
    lines.push('# structural');
    lines.push(..._capGraphList(summary.related));
  }
  if (summary.symbolImpact.length) {
    lines.push('');
    lines.push(targetSymbol ? '# symbol impact' : '# top symbol impact');
    lines.push(...summary.symbolImpact.slice(0, 5).map(_formatSymbolImpactLine));
  }
  if (summary.externalCallers.length) {
    lines.push('');
    lines.push('# external callers');
    lines.push(..._capGraphList(summary.externalCallers));
  }
  return lines.join('\n');
}

// ── Native graph binary (mixdog-graph) — single source of truth for
// per-file parsing. There is NO JS parsing fallback: if the binary is
// absent the build throws so the caller surfaces a clear, fixable error
// instead of silently degrading to a slow path.
function _graphBinaryPath() {
  const override = process.env.MIXDOG_GRAPH_BIN;
  if (override && existsSync(override)) return override;
  // fileURLToPath correctly decodes percent-encoded bytes (spaces, non-ASCII)
  // and strips the leading-slash/drive-letter quirk on Windows. Using
  // URL.pathname directly leaves `%20` etc. encoded, breaking paths with
  // spaces or non-ASCII characters.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const binName = process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph';
  // Prefer a local cargo build, then a previously fetched/cached prebuilt.
  const localBuild = pathResolve(moduleDir, '../../../../native/mixdog-graph/target/release', binName);
  if (existsSync(localBuild)) return localBuild;
  try { return findCachedGraphBinary(getPluginData()); } catch { return null; }
}

async function _runGraphBinaryJsonl(absRoot, extraArgs, stdinLines = null) {
  let binPath = _graphBinaryPath();
  if (!binPath) {
    // No local build or cached binary — fetch the prebuilt from the release
    // manifest (sha256-verified). No JS parse fallback: if the platform has
    // no asset or the download fails, the build throws with a fixable error.
    try {
      binPath = await ensureGraphBinary(getPluginData());
    } catch (err) {
      throw new Error(
        `[code-graph] mixdog-graph binary unavailable and could not be fetched: ${err?.message || err}. `
        + 'Build it (cargo build --release in native/mixdog-graph) or check network/release manifest.',
      );
    }
  }
  const { spawn } = await import('node:child_process');
  const timeoutMs = CODE_GRAPH_BINARY_TIMEOUT_MS;
  let retried = false;

  // Inner spawn + promise — extracted so we can retry once on EAGAIN.
  //
  // child-spawn-gate is NOT acquired here. This function runs inside the
  // code-graph prewarm WORKER THREAD (via _buildCodeGraph), and worker_threads
  // do not share module-level state with the main thread — acquiring here would
  // create a SECOND, independent semaphore that never coordinates with the
  // main-thread rg gate. Instead the gate is held on the MAIN THREAD across the
  // whole graph-build worker's lifetime (see buildCodeGraphAsync). The binary
  // child is spawned exclusively from this worker path, so one main-side slot
  // per worker correctly bounds native graph spawns against rg.
  const _spawnOnce = () => new Promise((resolve, reject) => {
    // When stdinLines is supplied (--files mode), stream one JSON object per
    // line to the child's STDIN — the reused nodes' metadata — so Rust can
    // resolve imports across the WHOLE tree (fresh + reused) while only
    // full-parsing the changed subset passed as argv.
    const wantsStdin = Array.isArray(stdinLines);
    const proc = spawn(binPath, [absRoot, ...extraArgs], {
      stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // windowsHide: native code-graph binary is a console exe; without this each
      // call flashes a console window when spawned under the detached daemon.
      windowsHide: true,
    });
    const chunks = [];
    let stderrText = '';
    const STDERR_CAP = 8 * 1024;
    let settled = false;
    let timedOut = false;

    // ── timeout + kill helpers (mirrors rg-runner's _killRgProc/_escalateRgKill) ──
    let timeoutTimer = null;
    let killGraceTimer = null;
    let forceSettleTimer = null;

    const _procGone = () => proc.exitCode != null || proc.signalCode != null;

    const _escalateKill = () => {
      if (_procGone()) return;
      const pid = proc.pid;
      if (!pid) return;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    };

    const _killProc = () => {
      if (_procGone()) return;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      if (killGraceTimer) {
        clearTimeout(killGraceTimer);
        killGraceTimer = null;
      }
      killGraceTimer = setTimeout(() => {
        killGraceTimer = null;
        _escalateKill();
      }, 3000);
      if (killGraceTimer.unref) killGraceTimer.unref();
    };

    const _clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (killGraceTimer) {
        clearTimeout(killGraceTimer);
        killGraceTimer = null;
      }
      if (forceSettleTimer) {
        clearTimeout(forceSettleTimer);
        forceSettleTimer = null;
      }
    };

    // Arm timeout — unref so it doesn't keep the process alive. On timeout we
    // start SIGTERM→grace→force-kill but do NOT settle yet: the promise stays
    // pending until the child's 'close' fires (so the build worker — and the
    // main-thread gate slot it holds — is only released once the process is
    // actually gone). A separate force-settle deadline guarantees the promise
    // still resolves if 'close' never arrives. Mirrors rg-runner exactly.
    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      timedOut = true;
      _killProc();
      // Hard backstop: if 'close' never fires after the kill escalation,
      // escalate again and settle so we never hang (and never release the
      // gate while the child is provably still alive without a final attempt).
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      forceSettleTimer = setTimeout(() => {
        forceSettleTimer = null;
        if (settled) return;
        _escalateKill();
        settled = true;
        _clearTimers();
        reject(new Error(`[code-graph] mixdog-graph timed out after ${timeoutMs}ms`));
      }, 5000);
      if (forceSettleTimer.unref) forceSettleTimer.unref();
    }, timeoutMs);
    if (timeoutTimer.unref) timeoutTimer.unref();

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => {
      if (stderrText.length >= STDERR_CAP) return;
      const piece = c.toString('utf8');
      const room = STDERR_CAP - stderrText.length;
      stderrText += piece.length > room ? piece.slice(0, room) : piece;
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      _clearTimers();
      reject(err);
    });
    if (wantsStdin) {
      proc.stdin.on('error', () => { /* child may close stdin early; ignore EPIPE */ });
      proc.stdin.write(stdinLines.length ? `${stdinLines.join('\n')}\n` : '');
      proc.stdin.end();
    }
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      _clearTimers();
      if (timedOut) {
        // Our timeout kill won the race: the child is gone now, so the gate
        // slot releases here (not at timeout-fire time). Report as a timeout.
        reject(new Error(`[code-graph] mixdog-graph timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`[code-graph] mixdog-graph exited ${code}: ${stderrText.trim().slice(0, 200)}`));
        return;
      }
      const out = [];
      const buf = Buffer.concat(chunks).toString('utf8');
      for (const line of buf.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed);
          if (rec && typeof rec.rel === 'string') out.push(rec);
        } catch { /* skip malformed line */ }
      }
      resolve(out);
    });
  });

  // Outer call with one EAGAIN retry (mirrors rg-runner runRg / runRgWindowedLines).
  try {
    return await _spawnOnce();
  } catch (err) {
    if (!retried && (err?.code === 'EAGAIN' || /EAGAIN/i.test(String(err?.message || err?.stderr || '')))) {
      retried = true;
      return _spawnOnce();
    }
    throw err;
  }
}
function _runGraphManifest(absRoot) { return _runGraphBinaryJsonl(absRoot, ['--manifest']); }
function _runGraphWalk(absRoot) { return _runGraphBinaryJsonl(absRoot, []); }
// --files (design A: full-graph resolution) full-parses only `rels` (argv) but
// resolves imports across the WHOLE tree. The reused nodes' metas are streamed
// to the child via STDIN as JSONL — one JSON object per line:
// {rel, lang, rawImports, packageName, namespaceName, goPackageName,
// topLevelTypes}. Rust builds the index + resolves over ALL nodes (fresh +
// reused) and emits fresh rels as full records, reused rels as lightweight
// {rel, resolvedImports, importedBy}.
function _runGraphFiles(absRoot, rels, reusedMetas) {
  const lines = Array.isArray(reusedMetas)
    ? reusedMetas.map((m) => JSON.stringify({
        rel: m.rel,
        lang: m.lang,
        rawImports: Array.isArray(m.rawImports) ? m.rawImports : [],
        packageName: m.packageName || '',
        namespaceName: m.namespaceName || '',
        goPackageName: m.goPackageName || '',
        topLevelTypes: Array.isArray(m.topLevelTypes) ? m.topLevelTypes : [],
      }))
    : [];
  return _runGraphBinaryJsonl(absRoot, ['--files', ...rels], lines);
}

// Map a Rust FileRecord (rel/lang/fp/tokens/rawImports/resolvedImports/
// importedBy/...) onto the JS fileInfo shape the graph assembler expects.
// Import resolution — including Go module paths — now happens entirely in
// Rust; resolvedImports/importedBy are repo-relative path lists passed
// straight through.
function _fileInfoFromRustRecord(rec, absRoot) {
  const rel = rec.rel;
  const abs = pathResolve(absRoot, rel);
  const lang = rec.lang;
  return {
    abs,
    rel,
    lang,
    fingerprint: typeof rec.fp === 'string' ? rec.fp : '',
    sourceText: null,
    rawImports: Array.isArray(rec.rawImports) ? rec.rawImports : [],
    resolvedImports: Array.isArray(rec.resolvedImports)
      ? rec.resolvedImports.filter((v) => typeof v === 'string')
      : [],
    importedBy: Array.isArray(rec.importedBy)
      ? rec.importedBy.filter((v) => typeof v === 'string')
      : [],
    packageName: typeof rec.packageName === 'string' ? rec.packageName : '',
    namespaceName: typeof rec.namespaceName === 'string' ? rec.namespaceName : '',
    goPackageName: typeof rec.goPackageName === 'string' ? rec.goPackageName : '',
    topLevelTypes: Array.isArray(rec.topLevelTypes) ? rec.topLevelTypes : [],
    tokenSymbols: Array.isArray(rec.tokens) ? rec.tokens : null,
    symbols: Array.isArray(rec.symbols) ? rec.symbols : [],
  };
}

// Reuse a node from the previous graph whose fp is unchanged — skips both
// the Rust call and re-parsing for files that did not change.
function _reuseFileInfo(prevNode, previousGraph, absRoot) {
  const rel = prevNode.rel;
  const fp = prevNode.fingerprint || '';
  const cachedText = previousGraph?._sourceTextCache?.get(rel);
  return {
    abs: prevNode.abs || pathResolve(absRoot, rel),
    rel,
    lang: prevNode.lang,
    fingerprint: fp,
    sourceText: cachedText?.fingerprint === fp ? cachedText.text : null,
    rawImports: Array.isArray(prevNode.rawImports) ? prevNode.rawImports : [],
    resolvedImports: Array.isArray(prevNode.resolvedImportsRel) ? prevNode.resolvedImportsRel : [],
    importedBy: Array.isArray(prevNode.importedBy) ? prevNode.importedBy : [],
    packageName: prevNode.packageName || '',
    namespaceName: prevNode.namespaceName || '',
    goPackageName: prevNode.goPackageName || '',
    topLevelTypes: Array.isArray(prevNode.topLevelTypes) ? prevNode.topLevelTypes : [],
    tokenSymbols: Array.isArray(prevNode.tokenSymbols) ? prevNode.tokenSymbols : null,
    symbols: Array.isArray(prevNode.symbols) ? prevNode.symbols : [],
  };
}

/**
 * Internal — exported solely for `code-graph-prewarm-worker.mjs` to import.
 * NOT part of the public API. External callers should use `buildCodeGraphAsync`
 * (worker-thread isolated) or the `code_graph` / `find_symbol` tools, never
 * this synchronous form on the main event loop.
 */
export async function _buildCodeGraph(cwd) {
  const now = Date.now();
  let _tp = performance.now();
  const _trace = (label) => { if (process.env.MIXDOG_GRAPH_TRACE) { const n = performance.now(); process.stderr.write(`[cg-trace] ${label}=${(n - _tp).toFixed(0)}ms\n`); _tp = n; } };
  const graphCwd = _canonicalGraphCwd(cwd);
  const absRoot = graphCwd;
  // Capture the dirty generation at build start. This build awaits the
  // manifest/walk; a write landing meanwhile bumps the generation and the
  // result must not be cached/persisted (it describes a pre-edit tree).
  const _genAtStart = _getCodeGraphGen(graphCwd);
  const cached = _codeGraphCache.get(graphCwd);
  let previousGraph = cached?.graph || null;
  // Dirty paths are subsumed by the manifest fp-diff below; drain the set
  // so it does not grow unbounded between builds.
  _consumeCodeGraphDirtyPaths(graphCwd);

  // 1. Change-detect via Rust --manifest (fp/rel/size only, no parse).
  //    The manifest is the FULL file list; the signature hashes every fp
  //    so a change beyond CODE_GRAPH_MAX_FILES still invalidates the cache
  //    and refreshes the `truncated` flag. Only `indexed` is built.
  const manifest = await _runGraphManifest(absRoot);
  const signature = _computeGraphSignature(manifest);
  _trace('manifest+sig');
  const truncated = manifest.length > CODE_GRAPH_MAX_FILES;
  const indexed = truncated ? manifest.slice(0, CODE_GRAPH_MAX_FILES) : manifest;

  // 2. Memory cache hit.
  if (cached && cached.signature === signature && now - cached.ts < CODE_GRAPH_TTL_MS) {
    _touchCodeGraphCache(graphCwd);
    return cached.graph;
  }

  // 3. Disk cache hit.
  _loadDiskCodeGraphCache(now);
  _ensureCwdLoaded(graphCwd);
  const diskEntry = _diskCodeGraphCache.get(graphCwd);
  if (diskEntry?.signature === signature) {
    const graph = _deserializeGraph(graphCwd, diskEntry);
    if (graph) {
      // Dirty-generation guard: skip caching if a write invalidated this
      // root since build start; still return the graph to the caller.
      if (_getCodeGraphGen(graphCwd) === _genAtStart) {
        _setCodeGraphCache(graphCwd, { ts: now, signature, graph });
      }
      return graph;
    }
  }
  if (!previousGraph && diskEntry) previousGraph = _deserializeGraph(graphCwd, diskEntry);
  // Schema guard: a graph built under an older symbol schema (pre-endLine)
  // must not seed incremental reuse. The schema-versioned signature already
  // blocks it from being SERVED as a direct cache hit, but its unchanged-fp
  // nodes would still be copied verbatim by _reuseFileInfo into the rebuilt
  // graph — carrying endLine-less symbols that defeat body-span containment.
  // Drop it so every node is re-parsed by the current binary.
  if (previousGraph && previousGraph.schemaVersion !== SYMBOL_SCHEMA_VERSION) {
    previousGraph = null;
  }

  // 4. Build fileInfos. Reuse unchanged nodes by fp; parse the rest in
  //    Rust — incrementally (--files) when only a subset changed, else a
  //    full cold walk. There is no JS parse path.
  const reusable = [];
  const freshRels = [];
  for (const meta of indexed) {
    const previousNode = previousGraph?.nodes?.get(meta.rel) || null;
    if (previousNode && previousNode.fingerprint === meta.fp) {
      reusable.push(_reuseFileInfo(previousNode, previousGraph, absRoot));
    } else {
      freshRels.push(meta.rel);
    }
  }
  let fileInfos;
  if (freshRels.length === 0) {
    fileInfos = reusable;
  } else if (reusable.length > 0 && freshRels.length <= 256) {
    // Design A — full-graph resolution. Send the reused nodes' metas to the
    // child via STDIN so Rust resolves imports over ALL nodes (fresh +
    // reused), not just freshRels. Rust returns fresh rels as FULL records and
    // reused rels as lightweight {rel, resolvedImports, importedBy}. Refresh
    // each reused node's resolved edges in place (its tokens/symbols/rawImports/
    // package* stay) so newly-satisfied/broken edges and package resolution no
    // longer go stale until a cold rebuild.
    const recs = await _runGraphFiles(absRoot, freshRels, reusable);
    const reusedByRel = new Map(reusable.map((info) => [info.rel, info]));
    const freshSet = new Set(freshRels);
    fileInfos = [...reusable];
    for (const rec of recs) {
      if (freshSet.has(rec.rel)) {
        // fresh rel → full new node.
        fileInfos.push(_fileInfoFromRustRecord(rec, absRoot));
      } else {
        // reused rel → keep the existing reused node, overwrite its resolved
        // edges (rel + abs) with the refreshed full-graph resolution.
        const reusedInfo = reusedByRel.get(rec.rel);
        if (!reusedInfo) continue;
        const resolved = Array.isArray(rec.resolvedImports)
          ? rec.resolvedImports.filter((v) => typeof v === 'string')
          : [];
        reusedInfo.resolvedImports = resolved;
        if (Array.isArray(rec.importedBy)) {
          reusedInfo.importedBy = rec.importedBy.filter((v) => typeof v === 'string');
        }
      }
    }
  } else {
    // Rust caps --walk at MAX_FILES; this slice is a defensive safety net.
    // `truncated` is already set from the full manifest above.
    let recs = await _runGraphWalk(absRoot);
    if (recs.length > CODE_GRAPH_MAX_FILES) recs = recs.slice(0, CODE_GRAPH_MAX_FILES);
    fileInfos = recs.map((rec) => _fileInfoFromRustRecord(rec, absRoot));
  }
  _trace('walk+parse');
  const nodes = new Map();
  const reverse = new Map();
  for (const info of fileInfos) {
    // Rust now emits repo-relative resolved edges directly. Keep the
    // downstream node shape stable: resolvedImports STAYS ABSOLUTE,
    // resolvedImportsRel is the rel list as-is, and reverse is rederived
    // below from the forward edges of every node.
    const resolvedImportsRel = Array.isArray(info.resolvedImports) ? info.resolvedImports : [];
    const importedBy = Array.isArray(info.importedBy) ? info.importedBy : [];
    const node = {
      abs: info.abs,
      rel: info.rel,
      lang: info.lang,
      fingerprint: info.fingerprint,
      rawImports: info.rawImports,
      resolvedImportsRel,
      resolvedImports: resolvedImportsRel.map((rel) => pathResolve(absRoot, rel)),
      importedBy,
      packageName: info.packageName,
      namespaceName: info.namespaceName,
      goPackageName: info.goPackageName,
      topLevelTypes: info.topLevelTypes,
      tokenSymbols: info.tokenSymbols,
      symbols: Array.isArray(info.symbols) ? info.symbols : [],
    };
    nodes.set(info.rel, node);
    // reverse is derived from the FORWARD edges of every node, not from
    // importedBy. On the incremental --files path Rust only emits records for
    // the parsed subset and reused nodes keep a stale importedBy, so a fresh
    // edge A→B (A parsed, B reused) would drop B's reverse entry until a cold
    // rebuild. Walking resolvedImportsRel keeps reverse self-consistent.
    for (const rel of resolvedImportsRel) {
      if (!reverse.has(rel)) reverse.set(rel, new Set());
      reverse.get(rel).add(node.rel);
    }
  }
  _trace('assemble');
  const graph = _attachGraphRuntimeCaches({ cwd: graphCwd, nodes, reverse, schemaVersion: SYMBOL_SCHEMA_VERSION, builtAt: now, signature });
  // Surface truncation so downstream output (find_symbol, overview) can
  // warn callers that the graph stopped at CODE_GRAPH_MAX_FILES rather
  // than indexing every eligible file under cwd.
  graph.truncated = Boolean(truncated);
  for (const info of fileInfos) {
    if (typeof info.sourceText === 'string') {
      graph._sourceTextCache.set(info.rel, {
        fingerprint: info.fingerprint || '',
        text: info.sourceText,
      });
    }
  }
  graph._symbolTokenIndexDirty = true;
  // Dirty-generation guard: a write that landed during the manifest/walk
  // bumped the generation; drop the now-stale result (no cache, no disk)
  // and return it only to the awaiting caller.
  if (_getCodeGraphGen(graphCwd) === _genAtStart) {
    _setCodeGraphCache(graphCwd, { ts: now, signature, graph });
    _setDiskCodeGraphEntry(graphCwd, graph);
    _trace('cache+disk');
  }
  return graph;
}

// Modes that operate on a single named symbol and can be looped to serve a
// multi-symbol request in one call (the graph is cwd-cached, so per-symbol
// re-entry is cheap). impact is excluded — it is file-scoped, not symbol-list.
const CODE_GRAPH_BATCHABLE_MODES = new Set(['symbol', 'find_symbol', 'symbol_search', 'callers', 'callees', 'references']);
// Collect requested symbol names from symbols[] (array), symbols (comma/space
// string), or symbol (single name OR comma/space-separated multi), de-duped in
// request order.
function _collectGraphSymbolList(args) {
  const split = (s) => String(s || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  return [...new Set([
    ...(Array.isArray(args?.symbols) ? args.symbols.map((s) => String(s || '').trim()).filter(Boolean) : []),
    ...(typeof args?.symbols === 'string' ? split(args.symbols) : []),
    ...(typeof args?.symbol === 'string' ? split(args.symbol) : []),
  ])];
}

async function codeGraph(args, cwd, signal = null, options = {}) {
  let mode = String(args?.mode || '').trim();
  if (!mode) throw new Error('code_graph: "mode" is required');
  // Alias: `search` reads like the web-search tool and misleads models into
  // firing broad keyword queries. `symbol_search` is the canonical name; keep
  // `search` working for back-compat by folding it in here.
  if (mode === 'search') mode = 'symbol_search';

  if (mode === 'prewarm') {
    // R5-③: TRUE fire-and-forget. Previously this function awaited
    // buildCodeGraphAsync above before branching into the prewarm path,
    // which defeated the prewarm contract — the caller blocked on the
    // very build prewarm is supposed to schedule. Handle prewarm BEFORE
    // the await so the caller returns immediately and the build runs
    // in the background.
    //
    // Build code graph + populate lazy per-symbol candidate cache for
    // the requested symbols. Caller does not block on the actual build;
    // returns immediately so the caller can pipeline its real
    // find_symbol calls right after.
    // Accepts symbols via: args.symbols (array), args.symbols (comma/space
    // separated string), or args.symbol (single name OR comma/space
    // separated multi). Client-side mcp schema caches sometimes strip
    // unknown fields, so the multi-form via the always-known `symbol`
    // field is the most portable.
    const _splitMulti = (s) => String(s || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    const fromSymbolsArr = Array.isArray(args?.symbols)
      ? args.symbols.map((s) => String(s || '').trim()).filter(Boolean)
      : [];
    const fromSymbolsStr = typeof args?.symbols === 'string' ? _splitMulti(args.symbols) : [];
    const fromSymbolField = typeof args?.symbol === 'string' ? _splitMulti(args.symbol) : [];
    const symbols = [...new Set([...fromSymbolsArr, ...fromSymbolsStr, ...fromSymbolField])];
    if (symbols.length > 0) prewarmCodeGraphSymbols(cwd, symbols);
    else prewarmCodeGraph(cwd);
    return `prewarm scheduled: cwd=${cwd} symbols=${symbols.length}${symbols.length ? ` (${symbols.slice(0, 5).join(',')}${symbols.length > 5 ? `,+${symbols.length - 5}` : ''})` : ''}`;
  }

  const graph = await buildCodeGraphAsync(cwd, signal);
  if (!graph || graph.nodes.size === 0) {
    throw new Error(`code_graph: cwd '${cwd}' is not an indexed/known project root or contains zero eligible files`);
  }
  if (options?.scopedCacheOutcome && graph.truncated) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  const normFile = normalizeInputPath(args?.file);
  const abs = normFile ? (isAbsolute(normFile) ? pathResolve(normFile) : pathResolve(cwd, normFile)) : null;
  let fileIsDirectory = false;
  if (abs) {
    try { fileIsDirectory = statSync(abs).isDirectory(); } catch { fileIsDirectory = false; }
  }
  const rel = abs && !fileIsDirectory ? _graphRel(abs, cwd) : null;
  const scopeRelPrefix = abs && fileIsDirectory
    ? (() => {
        const r = _graphRel(abs, cwd).replace(/\\/g, '/').replace(/\/+$/, '');
        return (!r || r === '.') ? null : `${r}/`;
      })()
    : null;
  const node = rel ? graph.nodes.get(rel) : null;

  if (mode === 'overview') {
    if (rel && !node) return _appendSameBasenameHint(`Error: code_graph overview: file not found in graph: ${normFile}`, normFile, graph);
    if (node) return _buildExplainerFileSummary(node, graph, cwd);
    const byLang = new Map();
    for (const node of graph.nodes.values()) {
      byLang.set(node.lang, (byLang.get(node.lang) || 0) + 1);
    }
    const lines = [
      `files\t${graph.nodes.size}`,
      `edges\t${Array.from(graph.nodes.values()).reduce((sum, n) => sum + n.resolvedImports.length, 0)}`,
    ];
    for (const [lang, count] of [...byLang.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`${lang}\t${count}`);
    }
    if (graph?.truncated) {
      lines.push(`WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — some files under cwd were not indexed`);
    }
    return lines.join('\n');
  }

  if (mode === 'imports') {
    if (!node) return _appendSameBasenameHint(`Error: code_graph imports: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    const GRAPH_LIST_CAP = 200;
    const resolvedAll = node.resolvedImports.map((p) => _graphRel(p, cwd));
    const rawAll = node.rawImports;
    const resolved = resolvedAll.slice(0, GRAPH_LIST_CAP);
    const raw = rawAll.slice(0, GRAPH_LIST_CAP);
    const parts = [];
    if (resolved.length) parts.push(resolved.join('\n'));
    if (raw.length) parts.push(`# raw\n${raw.join('\n')}`);
    if (resolvedAll.length > resolved.length || rawAll.length > raw.length) {
      parts.push(`[truncated — showing first ${GRAPH_LIST_CAP} of ${resolvedAll.length} resolved / ${rawAll.length} raw imports]`);
    }
    return parts.join('\n\n') || '(no imports)';
  }

  if (mode === 'dependents') {
    if (!rel) throw new Error('code_graph dependents: "file" is required');
    // Validate the path is actually indexed before answering. Without
    // this check, a typo or unsupported extension silently returns
    // "(no dependents)" — indistinguishable from a real zero-dependent
    // file and a frequent source of "graph says nothing depends on X"
    // false negatives.
    if (!node) return _appendSameBasenameHint(`Error: code_graph dependents: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    const GRAPH_LIST_CAP = 200;
    const depsAll = [...(graph.reverse.get(rel) || [])].sort();
    if (!depsAll.length) return '(no dependents)';
    const deps = depsAll.slice(0, GRAPH_LIST_CAP);
    // Enrich each dependent with the import line so callers do not need
    // a follow-up grep for `file:line`. Best-effort: if the importer
    // file cannot be read or no matching import line is found, fall back
    // to the bare relative path.
    const basename = rel.split('/').pop();
    const stem = basename.replace(/\.[^/.]+$/, '');
    const enriched = deps.map((dep) => {
      const depNode = graph.nodes.get(dep);
      if (!depNode) return dep;
      let text;
      try { text = readFileSync(depNode.abs, 'utf8'); } catch { return dep; }
      const linesArr = text.split(/\r?\n/);
      for (let i = 0; i < linesArr.length; i++) {
        const ln = linesArr[i];
        // The specifier line of a MULTI-LINE import (`} from './x.mjs';`) and
        // re-exports (`export ... from`) carry no import/require keyword on
        // that line — match the `from '...'` tail too, or those dependents
        // lose their :line.
        if (!/(?:^|\W)(?:import|require)\b|\bfrom\s*['"]/.test(ln)) continue;
        if (ln.includes(`/${basename}`) || ln.includes(`/${stem}`) || ln.includes(`'${basename}'`) || ln.includes(`"${basename}"`)) {
          return `${dep}:${i + 1}`;
        }
      }
      return dep;
    });
    const out = enriched.join('\n');
    return depsAll.length > deps.length
      ? `${out}\n[truncated — showing first ${GRAPH_LIST_CAP} of ${depsAll.length} dependents]`
      : out;
  }

  if (mode === 'related') {
    if (!node) return _appendSameBasenameHint(`Error: code_graph related: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    return _formatRelated(node, graph, cwd);
  }

  if (mode === 'impact') {
    if (!node) return _appendSameBasenameHint(`Error: code_graph impact: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    const targetSymbol = String(args?.symbol || '').trim();
    return _formatImpact(node, graph, cwd, targetSymbol);
  }

  if (mode === 'callees') {
    // FORWARD call navigation: mirror of `callers` (reverse). Given a
    // symbol X, locate its declaration via the existing find_symbol path,
    // then delegate body extraction + callee resolution to the shared
    // `_extractCallees` helper. The default `find_symbol` declaration
    // path also calls the same helper so structural forward-graph results
    // are returned without the caller having to pass mode:"callees".
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) throw new Error('code_graph callees: "symbol" is required.');
    const explicitLanguage = String(args?.language || '').trim() || null;
    if (rel && !node) return _appendSameBasenameHint(`Error: code_graph callees: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    const allHits = _findSymbolHits(graph, symbol, { language: explicitLanguage });
    const hits = rel ? allHits.filter((h) => h.rel === rel) : allHits;
    const declHit = hits.find((h) => h.declarationLike) || hits[0];
    if (!declHit) {
      const scopeNote = rel ? ` file=${rel}` : '';
      return `(no symbol matches in cwd=${cwd}${scopeNote})`;
    }
    if (!_CALLEES_BRACE_LANGS.has(declHit.lang)) {
      return `(callees unsupported for ${declHit.lang})`;
    }
    const rows = _extractCallees(graph, declHit, cwd, {
      cap: 200,
      callerSymbol: symbol,
      language: explicitLanguage,
    });
    if (!rows.length) return `(no callees)`;
    const out = ['# callees'];
    for (const row of rows) out.push(_formatCalleeRow(row));
    return out.join('\n');
  }

  if (mode === 'symbols') {
    if (!node) return _appendSameBasenameHint(`Error: code_graph symbols: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    let text = '';
    try { text = readFileSync(node.abs, 'utf8'); } catch { return '(no symbols)'; }
    return _extractSymbolsCheap(text, node.lang);
  }

  if (mode === 'find_symbol') {
    const symbol = String(args?.symbol || '').trim();
  if (!symbol) throw new Error('code_graph find_symbol: "symbol" is required.');
    const language = String(args?.language || '').trim() || null;
    const limit = Math.max(1, Math.min(50, Number(args?.limit || 20)));
    // SCOPE ISOLATION: if caller narrowed by `file`, validate it's indexed
    // then restrict hits to that file only (drop same-named symbols in
    // unrelated files).
    if (rel && !node) return _appendSameBasenameHint(`Error: code_graph find_symbol: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    return _findSymbolAcrossGraph(graph, symbol, cwd, { language, limit, fileRel: rel, body: args?.body !== false });
  }

  if (mode === 'symbol_search') {
    const keyword = String(args?.symbol || '').trim();
    if (!keyword) throw new Error('code_graph symbol_search: "symbol" is required.');
    const language = String(args?.language || '').trim() || null;
    const limit = Math.max(1, Math.min(100, Number(args?.limit || 30)));
    return _searchSymbolsByKeyword(graph, keyword, cwd, { language, limit });
  }

  if (mode === 'references') {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) throw new Error('code_graph references: "symbol" is required.');
    const explicitLanguage = String(args?.language || '').trim() || null;
    if (explicitLanguage) {
      const langHasFiles = [...graph.nodes.values()].some((n) => n.lang === explicitLanguage);
      if (!langHasFiles) {
        throw new Error(`code_graph references: language '${explicitLanguage}' has no adapter topLevelTypes and is not in supportedRegexLangs for this project`);
      }
    }
    const narrowedByCaller = Boolean(rel || scopeRelPrefix || explicitLanguage);
    const resolved = _resolveReferenceLanguageNode(graph, symbol, rel, cwd, explicitLanguage);
    // Distinguish "file path was never indexed" from "file is indexed but the
    // symbol never appears in it". The former is a path/scope problem (typo,
    // unsupported extension); the latter is a real zero-hit answer scoped to
    // the requested file. Both still terminate the request when the caller
    // narrowed by file, but the message lets the caller pick the right
    // recovery (fix the path vs. drop the file filter / widen the search).
    if (rel && resolved.kind === 'file-not-found') {
      return _appendSameBasenameHint(`Error: code_graph references: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    }
    if (rel && resolved.kind === 'symbol-not-present') {
      return `Error: code_graph references: symbol "${symbol}" not found in ${normFile || rel}`;
    }
    const resolvedNode = resolved.kind === 'ok' ? resolved.node : null;
    // Bare references (no file/language narrow) → search every language so
    // a symbol with the same name in TS+PY isn't quietly truncated to
    // whichever language the first hit happened to land in.
    // Explicit language is a hard scope — preserve it even when the resolver
    // failed to land on a node, so the search doesn't silently widen to every
    // language (mirrors callers mode at the matching site). Bare refs with no
    // file/language narrow still search all languages.
    const lang = explicitLanguage
      || ((narrowedByCaller && resolvedNode) ? resolvedNode.lang : null);
    // Only use args.limit when it's a positive finite number. 0/negative/
    // missing all fall back to null → ENV_CAP (REFERENCE_HIT_CAP) so the
    // no-limit caller gets the full result set as before. Clamp upper
    // bound at 500 to keep payloads sane.
    const rawLimit = Number(args?.limit);
    const userLimit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(500, Math.floor(rawLimit))
      : null;
    // Parallel pre-read so the sync search inside _cheapReferenceSearch
    // hits the in-memory text cache instead of paying ~200 serial disk reads.
    await _prewarmReferenceSourceText(graph, symbol, lang);
    // SCOPE ISOLATION: when `file` is set, restrict reference search to
    // that single file so a caller asking "refs in foo.mjs" doesn't get
    // hits from every other file that happens to share the identifier.
    const refResult = _cheapReferenceSearch(graph, symbol, cwd, { language: lang, limit: userLimit, fileRel: rel, scopeRelPrefix });
    return narrowedByCaller ? refResult : _augmentNoHitDiagnostic(refResult, '(no references)', graph, cwd, symbol);
  }

  if (mode === 'callers') {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) throw new Error('code_graph callers: "symbol" is required.');
    const explicitLanguage = String(args?.language || '').trim() || null;
    // Validate explicit-language scope up front so callers mode mirrors the
    // references-mode contract: an unrecognised/unindexed language is a
    // hard scope error, not a silent fall-through to a broader search.
    if (explicitLanguage) {
      const langHasFiles = [...graph.nodes.values()].some((n) => n.lang === explicitLanguage);
      if (!langHasFiles) {
        throw new Error(`code_graph callers: language '${explicitLanguage}' has no adapter topLevelTypes and is not in supportedRegexLangs for this project`);
      }
    }
    const narrowedByCaller = Boolean(rel || scopeRelPrefix || explicitLanguage);
    const resolved = _resolveReferenceLanguageNode(graph, symbol, rel, cwd, explicitLanguage);
    if (rel && resolved.kind === 'file-not-found') {
      return _appendSameBasenameHint(`Error: code_graph callers: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    }
    if (rel && resolved.kind === 'symbol-not-present') {
      return `Error: code_graph callers: symbol "${symbol}" not found in ${normFile || rel}`;
    }
    const resolvedNode = resolved.kind === 'ok' ? resolved.node : null;
    // Explicit language is a hard scope — keep it even when the resolver
    // failed to land on a node, so the downstream cheap reference search
    // doesn't silently widen to every language.
    const lang = explicitLanguage
      || ((narrowedByCaller && resolvedNode) ? resolvedNode.lang : null);
    // Only positive finite limits propagate. 0/negative/missing fall back
    // to ENV_CAP via the formatter+search defaults.
    const rawLimit = Number(args?.limit);
    const userLimit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(500, Math.floor(rawLimit))
      : null;
    // Parallel pre-read so the sync search hits the in-memory text cache.
    await _prewarmReferenceSourceText(graph, symbol, lang);
    // Transitive upstream tree: depth>1 walks caller-of-caller up to `depth`
    // levels in ONE call (replaces manual per-level callers batching). depth<=1
    // keeps the single-level path byte-identical. Graph-wide by design (the
    // chain crosses modules); file: scope is ignored for the transitive walk.
    const depth = Math.max(1, Math.min(5, Math.floor(Number(args?.depth) || 1)));
    if (depth > 1) {
      return _formatTransitiveCallers(graph, symbol, cwd, { language: lang, depth, page: args?.page });
    }
    // SCOPE ISOLATION: file-narrowed callers stays within that file too.
    const refs = _cheapReferenceSearch(graph, symbol, cwd, { language: lang, limit: userLimit, fileRel: rel, scopeRelPrefix });
    const callerResult = _formatCallerReferences(graph, symbol, refs, userLimit ? { limit: userLimit } : undefined);
    return narrowedByCaller ? callerResult : _augmentNoHitDiagnostic(callerResult, '(no callers)', graph, cwd, symbol);
  }

  throw new Error(`code_graph: unknown mode "${mode}"`);
}

async function findSymbolTool(args, cwd, signal = null, options = {}) {
  // Prewarm short-circuit: no graph build await, fire-and-forget. Returns
  // immediately so Lead can issue prewarm at session start then pipeline
  // real find_symbol calls without blocking on the cold-process scan.
  if (args?.mode === 'prewarm') {
    const _splitMulti = (s) => String(s || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    const fromSymbolsArr = Array.isArray(args?.symbols)
      ? args.symbols.map((s) => String(s || '').trim()).filter(Boolean)
      : [];
    const fromSymbolsStr = typeof args?.symbols === 'string' ? _splitMulti(args.symbols) : [];
    const fromSymbolField = typeof args?.symbol === 'string' ? _splitMulti(args.symbol) : [];
    const symbols = [...new Set([...fromSymbolsArr, ...fromSymbolsStr, ...fromSymbolField])];
    if (symbols.length > 0) prewarmCodeGraphSymbols(cwd, symbols);
    else prewarmCodeGraph(cwd);
    return `prewarm scheduled: cwd=${cwd} symbols=${symbols.length}${symbols.length ? ` (${symbols.slice(0, 5).join(',')}${symbols.length > 5 ? `,+${symbols.length - 5}` : ''})` : ''}`;
  }
  const graph = await buildCodeGraphAsync(cwd, signal);
  if (!graph) throw new Error(`find_symbol: cwd '${cwd}' is not an indexed/known project root or contains zero eligible files`);
  if (options?.scopedCacheOutcome && graph.truncated) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  const symbol = String(args?.symbol || '').trim();
  const language = String(args?.language || '').trim() || null;
  const limit = Math.max(1, Math.min(50, Number(args?.limit || 20)));
  // SCOPE ISOLATION: when `file` is supplied, restrict hits to that file's
  // declaration + refs (don't return every same-named symbol across the
  // tree). Validates the path is actually indexed so a typo surfaces a
  // clear error instead of a silent "(no symbol matches)".
  const normFile = normalizeInputPath(args?.file);
  const abs = normFile ? (isAbsolute(normFile) ? pathResolve(normFile) : pathResolve(cwd, normFile)) : null;
  const fileRel = abs ? _graphRel(abs, cwd) : null;
  if (fileRel && !graph.nodes.get(fileRel)) {
    return _appendSameBasenameHint(`Error: find_symbol: file not found in graph: ${normFile}`, normFile, graph);
  }
  // FILE-OVERVIEW MODE: `symbol` omitted but `file` given → list that file's
  // symbols (mirrors the dispatcher's `symbols` mode). The tool spec allows
  // "symbol (to locate) OR file (to list its symbols)"; the bare-`symbol`
  // guard here used to reject this otherwise-valid file-only call.
  if (!symbol) {
    if (fileRel) {
      const node = graph.nodes.get(fileRel);
      let text = '';
      try { text = readFileSync(node.abs, 'utf8'); } catch { return '(no symbols)'; }
      return _extractSymbolsCheap(text, node.lang);
    }
    throw new Error('find_symbol: provide "symbol" (to locate) or "file" (to list its symbols).');
  }
  return _findSymbolAcrossGraph(graph, symbol, cwd, { language, limit, fileRel, body: args?.body !== false });
}



export { CODE_GRAPH_TOOL_DEFS } from './code-graph-tool-defs.mjs';

/**
 * Resolve a symbol name to a 1-based [startLine, endLine] declaration span for read().
 * Returns `{ offset, limit, startLine, endLine, rel, note? }` or `{ error }`.
 */
// Recover the end line of a brace-delimited declaration whose endLine the
// graph does not record (assignment-style decls): the body closes at the
// first `}`-leading line indented at or left of the declaration line. Exact
// for conventionally-indented code; returns null (caller falls back) when no
// such line exists within the scan window — e.g. minified or single-line.
const SYMBOL_SPAN_SCAN_MAX_LINES = 400;
function _inferSpanEndByIndent(allLines, startLine) {
  const decl = allLines[startLine - 1];
  if (typeof decl !== 'string' || !/[{([]\s*$/.test(decl.trimEnd())) return null;
  const declIndent = decl.match(/^[ \t]*/)[0].length;
  const last = Math.min(allLines.length, startLine - 1 + SYMBOL_SPAN_SCAN_MAX_LINES);
  for (let i = startLine; i < last; i++) {
    const line = allLines[i];
    if (!/^[ \t]*[})\]]/.test(line)) continue;
    const indent = line.match(/^[ \t]*/)[0].length;
    if (indent <= declIndent) return i + 1;
  }
  return null;
}

export async function resolveSymbolReadSpan(cwd, { symbol, path = null, language = null, line = null } = {}) {
  const cleanSymbol = String(symbol || '').trim();
  if (!cleanSymbol) return { error: 'symbol is required' };
  let graph;
  try {
    graph = await buildCodeGraphAsync(cwd);
  } catch (err) {
    return { error: `symbol read: code graph unavailable (${err?.message || err})` };
  }
  if (!graph) return { error: 'symbol read: code graph could not be built for cwd' };

  const normFile = path ? normalizeInputPath(path) : null;
  const abs = normFile ? (isAbsolute(normFile) ? pathResolve(normFile) : pathResolve(cwd, normFile)) : null;
  const fileRel = abs ? _graphRel(abs, cwd) : null;
  if (fileRel && !graph.nodes.get(fileRel)) {
    return { error: `symbol '${cleanSymbol}' not found — file not indexed: ${path}; use find_symbol` };
  }

  let hits = _findSymbolHits(graph, cleanSymbol, { language });
  if (fileRel) hits = hits.filter((h) => h.rel === fileRel);
  if (!hits.length) {
    const scope = fileRel ? ` in ${fileRel}` : '';
    return { error: `symbol '${cleanSymbol}' not found${scope}; use find_symbol to locate it` };
  }

  const disambigLine = Number(line);
  let primary;
  if (Number.isFinite(disambigLine) && disambigLine > 0) {
    const onLine = hits.filter((h) => h.line === disambigLine);
    primary = _pickCalleeDeclHit(onLine.length ? onLine : hits, fileRel);
  } else {
    primary = _pickCalleeDeclHit(hits, fileRel);
  }
  if (!primary) return { error: `symbol '${cleanSymbol}' not found; use find_symbol` };

  const startLine = Number(primary.line);
  let endLine = Number(primary.endLine);
  let approximate = false;
  if (!Number.isFinite(startLine) || startLine < 1) {
    return { error: `symbol '${cleanSymbol}' has no valid declaration line; use find_symbol` };
  }
  if (!Number.isFinite(endLine) || endLine < startLine) {
    // Assignment-style decls record no endLine; a fixed +79 window over-reads
    // short arrows ~4x and truncates longer ones. Recover the real span from
    // indentation; fall back to the fixed window only when the scan fails.
    const node = graph.nodes.get(primary.rel);
    const srcText = node ? _getSourceTextForNode(graph, node) : null;
    const inferred = srcText ? _inferSpanEndByIndent(srcText.split('\n'), startLine) : null;
    if (inferred) {
      endLine = inferred;
    } else {
      endLine = startLine + 79;
      approximate = true;
    }
  }
  const declCount = hits.filter((h) => h.declarationLike).length;
  const notes = [];
  if (approximate) notes.push('end line unknown — approximate range from declaration line');
  if (!fileRel && (hits.length > 1 || declCount > 1)) {
    notes.push('other matches exist — pass path= (and line= to disambiguate) to scope');
  } else if (fileRel && declCount > 1) {
    notes.push(
      `${declCount} declarations of '${cleanSymbol}' in this file — reading the first; pass line= to pick another`,
    );
  }

  return {
    rel: primary.rel,
    startLine,
    endLine,
    offset: startLine - 1,
    limit: endLine - startLine + 1,
    approximate,
    note: notes.length ? notes.join('; ') : undefined,
  };
}

// MCP clients sometimes inject empty-string defaults for optional schema
// fields (e.g. `file: ""`). That empty path round-trips through
// normalizeInputPath as a literal string, populating `rel` and tripping
// the "file not found in graph" early-return in callers/references modes
// even when the caller intended bare-symbol search. Strip empty/null
// optional path-like fields before dispatch.
function _stripEmptyArgs(args) {
  const a = { ...(args || {}) };
  for (const k of ['file', 'language']) {
    if (a[k] === '' || a[k] === null) delete a[k];
  }
  return a;
}

// P1: project-root sentinels. A directory containing any of these (or with one
// at an ancestor) is treated as a real project we may index. Used to (a) re-root
// a file that sits outside cwd to its own project, and (b) refuse to index an
// arbitrary non-project tree (home dir, multi-repo container, plugin cache) on
// an implicit cwd.
const _PROJECT_ROOT_SENTINELS = ['package.json', '.git', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt', 'Package.swift'];

// P1: resolve a file to its nearest project root (sentinel ancestor).
// Returns null when no root found; caller throws rather than falling back silently.
function _resolveFileProjectRoot(file) {
  if (!file) return null;
  const abs = pathResolve(file);
  let dir = dirname(abs);
  while (dir && dir !== dirname(dir)) {
    if (_PROJECT_ROOT_SENTINELS.some((s) => existsSync(join(dir, s)))) return dir;
    dir = dirname(dir);
  }
  return null;
}

// P1: nearest project root for a DIRECTORY (the dir itself or any ancestor).
// Returns null when the dir sits in no project — the signal to refuse an
// unscoped, implicit-cwd index of an arbitrary tree.
function _findDirProjectRoot(dir) {
  if (!dir) return null;
  let d = pathResolve(dir);
  while (d && d !== dirname(d)) {
    if (_PROJECT_ROOT_SENTINELS.some((s) => existsSync(join(d, s)))) return d;
    d = dirname(d);
  }
  return null;
}

// #4: when an UNSCOPED refs/callers query comes back empty, the symbol is absent
// from the graph entirely — often because cwd points at the wrong tree. Append
// the graph root + indexed-file count so the caller can tell "genuinely no
// callers" from "wrong cwd". A file/language-scoped empty result is a real
// scoped answer and is left untouched (caller passes narrowedByCaller).
function _augmentNoHitDiagnostic(result, emptyToken, graph, cwd, symbol) {
  if (typeof result !== 'string' || result.trim() !== emptyToken) return result;
  const n = graph?.nodes?.size || 0;
  const trunc = graph?.truncated ? `, graph truncated at ${CODE_GRAPH_MAX_FILES} files` : '';
  // Distinguish "defined but no edge" from "not indexed at all". An empty
  // callers/references/callees result for a symbol that HAS a declaration in
  // this graph means it is genuinely unreferenced here — NOT missing. Telling
  // the caller it is "not present / likely outside cwd" sends them on a
  // needless re-scope/grep hunt.
  let declHit = null;
  try { declHit = (_sortSymbolHits(_findSymbolHits(graph, symbol, {})) || [])[0] || null; } catch {}
  if (declHit) {
    return `${emptyToken}\n# '${symbol}' IS defined (${_formatSymbolHitLocation(declHit)}) but is genuinely unreferenced in this graph — present, not missing. No re-scope / grep needed.`;
  }
  return `${emptyToken}\n# '${symbol}' not present in graph rooted at ${cwd} (${n} files indexed${trunc}). `
    + `If it should exist, the target is likely outside this cwd — pass an explicit 'cwd' (repo root) or 'file' anchor, or run 'cwd set <repo>'.`;
}

export async function executeCodeGraphTool(name, args, cwd, signal = null, options = {}) {
  if (!cwd) throw new Error('find_symbol/code_graph requires cwd — caller did not provide a working directory');
  const fileArg = (args && typeof args.file === 'string' && args.file.trim()) ? args.file.trim() : '';
  const baseCwd = (args && typeof args.cwd === 'string' && args.cwd.trim()) ? args.cwd.trim() : cwd;
  let effectiveCwd = baseCwd;
  if (fileArg) {
    const abs = isAbsolute(fileArg) ? pathResolve(fileArg) : pathResolve(baseCwd, fileArg);
    if (!existsSync(abs)) {
      // Same right-name / wrong-directory recovery the read path provides
      // (read-single-tool.mjs): most misses here are hallucinated-but-plausible
      // paths whose basename exists elsewhere in the repo. Name the real
      // location(s) so the next call self-corrects in one turn.
      const elsewhere = findFileByBasename(pathResolve(baseCwd), abs);
      const hint = elsewhere.length
        ? ` Same filename exists at: ${elsewhere.map((p) => `"${toDisplayPath(p, baseCwd).replace(/\\/g, '/')}"`).join(', ')}. Use that path.`
        : '';
      return `Error: ${name}: file not found: ${fileArg}${hint}`;
    }
    let fileArgIsDirectory = false;
    try { fileArgIsDirectory = statSync(abs).isDirectory(); } catch { fileArgIsDirectory = false; }
    const rel = pathRelative(pathResolve(baseCwd), abs);
    const insideCwd = rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
    if (!insideCwd) {
      // P1: file outside cwd — require explicit cwd arg or detectable project root; throw otherwise.
      const hasExplicitCwd = args && typeof args.cwd === 'string' && args.cwd.trim();
      if (!hasExplicitCwd) {
        const fileRoot = fileArgIsDirectory ? _findDirProjectRoot(abs) : _resolveFileProjectRoot(abs);
        if (!fileRoot) {
          throw new Error(`find_symbol: file '${fileArg}' is outside cwd '${baseCwd}' and has no detectable project root (no package.json/.git ancestor). Provide an explicit cwd.`);
        }
        effectiveCwd = fileRoot;
      }
    }
  }
  // P1 (fail-loud root): an UNSCOPED query (no file anchor) on an IMPLICIT cwd
  // must sit inside a real project. Otherwise we would index whatever giant tree
  // the session cwd points at (home dir, a multi-repo container, a plugin cache)
  // — burning the worker-build budget and then silently answering refs/callers
  // from the wrong graph. An explicit `cwd` arg is trusted (the caller opted in,
  // e.g. a large monorepo). Refuse loudly otherwise.
  if (!fileArg && !(args && typeof args.cwd === 'string' && args.cwd.trim())) {
    const projectRoot = _findDirProjectRoot(effectiveCwd);
    if (!projectRoot) {
      throw new Error(
        `${name}: cwd '${effectiveCwd}' is not inside a project (no `
        + `${_PROJECT_ROOT_SENTINELS.join('/')} at it or any ancestor). Refusing to `
        + `index an arbitrary tree. Run 'cwd set <repo>', or pass an explicit `
        + `'cwd' (repo root) or a 'file' anchor.`);
    }
    // ② Re-root an implicit SUBDIR cwd up to its project root so an unscoped
    // query covers the whole repo (e.g. callers in sibling dirs like scripts/,
    // not just the subtree under cwd). effectiveCwd flows consistently into the
    // build root, rel-keys, output scope, and cache key downstream — the same
    // dispatch-boundary re-root the file-anchor branch performs above. A cwd
    // that is already its own project root re-roots to itself (no-op).
    effectiveCwd = projectRoot;
  }
  if (signal?.aborted) throw new Error('aborted');
  const _work = (() => {
    switch (name) {
      case 'code_graph': {
        // `find_symbol` mode keeps the legacy plain-declaration lookup that the
        // standalone find_symbol tool used to provide (prewarm + file-overview
        // without a symbol). All other modes flow through codeGraph().
        const rawMode = String(args?.mode || '').trim();
        const batchMode = rawMode === 'search' ? 'symbol_search' : rawMode;
        const declModes = new Set(['symbol', 'find_symbol']);
        const dispatchOne = (a) => (declModes.has(rawMode)
          ? findSymbolTool(_stripEmptyArgs(a), effectiveCwd, signal, options)
          : codeGraph(a, effectiveCwd, signal, options));
        // Multi-symbol batch: run a batchable mode once per requested name and
        // concatenate, so N lookups cost ONE call. A single name falls through
        // unchanged (no header) — existing single calls are byte-identical.
        if (CODE_GRAPH_BATCHABLE_MODES.has(batchMode)) {
          const symbolList = _collectGraphSymbolList(args);
          if (symbolList.length > 1) {
            return (async () => {
              const sections = [];
              for (const sym of symbolList) {
                let body;
                try { body = await dispatchOne({ ...args, symbol: sym, symbols: undefined }); }
                catch (e) { body = `Error: ${e?.message || String(e)}`; }
                sections.push(`# ${batchMode} ${sym}\n${body}`);
              }
              return sections.join('\n\n');
            })();
          }
          if (symbolList.length === 1 && args?.symbol !== symbolList[0]) {
            return dispatchOne({ ...args, symbol: symbolList[0], symbols: undefined });
          }
        }
        return dispatchOne(args);
      }
      default: throw new Error(`Unknown code-graph tool: ${name}`);
    }
  })();
  if (!signal) return _work;
  let onAbort = null;
  const abortP = new Promise((_, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const cleanup = () => {
    if (onAbort) {
      try { signal.removeEventListener('abort', onAbort); } catch {}
      onAbort = null;
    }
  };
  return Promise.race([_work, abortP]).then(
    (v) => { cleanup(); return v; },
    (e) => { cleanup(); throw e; },
  );
}

export function isCodeGraphTool(name) {
  return CODE_GRAPH_TOOL_DEFS.some((t) => t.name === name);
}
