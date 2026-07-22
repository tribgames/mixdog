// Graph build orchestration: worker-thread async build (buildCodeGraphAsync),
// synchronous _buildCodeGraph (imported by the prewarm worker), and the
// prewarm entry points. Owns the in-flight single-flight map. Extracted
// verbatim from code-graph.mjs.
//
// SELF-REFERENTIAL DYNAMIC IMPORT: buildCodeGraphAsync spawns the prewarm
// worker via `new URL('../code-graph-prewarm-worker.mjs', import.meta.url)`.
// That worker in turn does `import { _buildCodeGraph } from '../code-graph.mjs'`
// (the facade), which re-exports _buildCodeGraph from THIS module. The worker
// path is unchanged relative to the facade, so it keeps importing the facade —
// no module imports its own path. The URL below is resolved against THIS
// module's dir (tools/code-graph/), so it walks one level up to reach the
// worker at tools/.
import {
  isAbsolute,
  relative as pathRelative,
  resolve as pathResolve,
  win32 as pathWin32,
} from 'node:path';
import { Worker } from 'node:worker_threads';
import { acquire as acquireChildSpawnSlot, hasSpareCapacity as childSpawnHasSpareCapacity } from '../../../../shared/child-spawn-gate.mjs';
import {
  canonicalGraphCwd as _canonicalGraphCwd,
  codeGraphCache as _codeGraphCache,
  consumeCodeGraphDirtyPaths as _consumeCodeGraphDirtyPaths,
  getCodeGraphGen as _getCodeGraphGen,
} from '../code-graph-state.mjs';
import {
  CODE_GRAPH_TTL_MS,
  CODE_GRAPH_MAX_FILES,
  CODE_GRAPH_FAST_PATH_MAX_BYTES,
  CODE_GRAPH_WORKER_TIMEOUT_MS,
  SYMBOL_SCHEMA_VERSION,
} from './constants.mjs';
import {
  _computeGraphSignature,
  _deserializeGraph,
  _attachGraphRuntimeCaches,
} from './graph-model.mjs';
import { _touchCodeGraphCache, _setCodeGraphCache } from './memory-cache.mjs';
import {
  ensureDiskCodeGraphLoaded,
  drainCodeGraphCacheStrict,
  getDiskCodeGraphEntry,
  probeDiskCodeGraphEntry,
  _setDiskCodeGraphEntry,
} from './disk-cache.mjs';
import {
  _runGraphManifest,
  _runGraphWalk,
  _runGraphFiles,
  _fileInfoFromRustRecord,
  _reuseFileInfo,
} from './graph-binary.mjs';
import { _lookupCandidateNodes } from './symbol-index.mjs';
import { _findDirProjectRoot } from './project-root.mjs';

// In-flight async builds keyed by canonical graphCwd. Same-cwd parallel
// callers (prewarm + cache-miss + multiple find_symbol) share one Worker
// spawn instead of fanning out. Entry removed on settle so the next caller
// after a failure can retry.
const _inflightAsyncBuilds = new Map();
const CODE_GRAPH_FILES_ARG_MAX_CHARS = 16_000;

function _usesWindowsPathSemantics(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function _normalizedExcludedPrefixes(cwd, excludedProjectRoots) {
  const windows = _usesWindowsPathSemantics(cwd);
  const relative = windows ? pathWin32.relative : pathRelative;
  const resolve = windows ? pathWin32.resolve : pathResolve;
  return [...new Set((excludedProjectRoots || []).map((root) => {
    let rel = relative(cwd, resolve(root)).replace(/\\/g, '/').replace(/\/+$/, '');
    if (windows) rel = rel.toLowerCase();
    const absolute = windows ? pathWin32.isAbsolute(rel) : isAbsolute(rel);
    return rel && !rel.startsWith('../') && !absolute ? rel : null;
  }).filter(Boolean))].sort();
}

// Exported for the focused pre-cap exclusion regression.
export function _scopeCodeGraphManifest(manifest, cwd, {
  excludedProjectRoots = [],
  maxFiles = CODE_GRAPH_MAX_FILES,
} = {}) {
  const prefixes = _normalizedExcludedPrefixes(cwd, excludedProjectRoots);
  const windows = _usesWindowsPathSemantics(cwd);
  const excluded = (rel) => {
    const normalized = rel.replace(/\\/g, '/');
    const comparable = windows ? normalized.toLowerCase() : normalized;
    return prefixes.some((prefix) => comparable === prefix || comparable.startsWith(`${prefix}/`));
  };
  const scoped = (Array.isArray(manifest) ? manifest : [])
    .filter((meta) => meta && typeof meta.rel === 'string' && !excluded(meta.rel));
  const cap = Math.max(1, Math.floor(Number(maxFiles) || CODE_GRAPH_MAX_FILES));
  return {
    manifest: scoped,
    indexed: scoped.length > cap ? scoped.slice(0, cap) : scoped,
    truncated: scoped.length > cap,
    prefixes,
  };
}

export function _isCompatibleDiskCodeGraphEntry(entry, maxFiles = CODE_GRAPH_MAX_FILES) {
  return Number.isFinite(entry?.maxFiles) && entry.maxFiles === maxFiles;
}

function _throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('aborted');
}

// Validate an already-loaded disk entry before paying Worker startup. The
// manifest process is async; its child-spawn slot is held by the caller until
// either this returns a hit or the Worker takes over the same slot on a miss.
// Exported for the focused deterministic cache-validation test.
export async function _validateDiskCodeGraphHit({
  graphCwd,
  diskEntry,
  genAtStart,
  now = Date.now(),
  runManifest = _runGraphManifest,
  computeSignature = _computeGraphSignature,
  deserializeGraph = _deserializeGraph,
  getGeneration = _getCodeGraphGen,
  setMemoryCache = _setCodeGraphCache,
  signal = null,
}) {
  if (!_isCompatibleDiskCodeGraphEntry(diskEntry)) return { incompatible: true };
  const manifest = await runManifest(graphCwd, signal);
  const signature = computeSignature(manifest);
  if (diskEntry.signature !== signature) return { graph: null, manifest, signature };
  const graph = deserializeGraph(graphCwd, diskEntry);
  if (!graph) return { graph: null, manifest, signature };
  if (getGeneration(graphCwd) !== genAtStart) return { invalidated: true };
  setMemoryCache(graphCwd, { ts: now, signature, graph });
  return { graph, manifest, signature };
}

// Owns a pre-acquired slot until a validated miss hands it to spawnWorker.
// Keeping this seam dependency-injectable makes slot/abort behavior testable
// without spawning native processes or Worker threads.
export async function _runDiskCodeGraphFastPath({
  graphCwd,
  diskProbe,
  genAtStart,
  signal = null,
  loadDiskEntry,
  consumeDirty = () => {},
  acquireSlot = acquireChildSpawnSlot,
  validateDiskHit = _validateDiskCodeGraphHit,
  spawnWorker,
  maxFiles = CODE_GRAPH_MAX_FILES,
}) {
  if (!diskProbe?.isFastPathEligible || diskProbe.maxFiles !== maxFiles) {
    return spawnWorker(null, null, null);
  }
  const diskEntry = loadDiskEntry();
  if (!_isCompatibleDiskCodeGraphEntry(diskEntry, maxFiles)) {
    return spawnWorker(null, null, null);
  }
  consumeDirty();
  const release = await acquireSlot(signal || null);
  let handedToWorker = false;
  try {
    _throwIfAborted(signal);
    const hit = await validateDiskHit({ graphCwd, diskEntry, genAtStart, signal });
    _throwIfAborted(signal);
    if (hit?.invalidated) throw new Error('code-graph build invalidated during prewarm');
    if (hit?.graph) return hit.graph;
    _throwIfAborted(signal);
    const workerPromise = spawnWorker(release, hit?.manifest || null, hit?.signature || null);
    handedToWorker = true;
    return workerPromise;
  } finally {
    if (!handedToWorker) release();
  }
}

export function _prepareDiskCodeGraphFastPath({
  graphCwd,
  ensureDiskLoaded = ensureDiskCodeGraphLoaded,
  probeDiskEntry = probeDiskCodeGraphEntry,
  runFastPath,
}) {
  ensureDiskLoaded();
  return runFastPath(probeDiskEntry(graphCwd, CODE_GRAPH_FAST_PATH_MAX_BYTES));
}

// Worker disk writes are debounced with an unref'd timer. Drain before sending
// success so every loaded cwd persists before this Worker can
// exit; a drain failure is intentionally thrown to the worker's failure path.
export function _postCodeGraphWorkerSuccess(
  graph,
  postMessage,
  drainCache = drainCodeGraphCacheStrict,
  { cache = true } = {},
) {
  if (cache) drainCache();
  postMessage({ ok: true, signature: graph.signature, graph });
}

// Structured keys avoid both separator collisions inside roots/prefixes and
// collisions between scoped and ordinary builds.
export function _codeGraphInflightKey(graphCwd, {
  scoped = false,
  maxFiles = CODE_GRAPH_MAX_FILES,
  prefixes = [],
} = {}) {
  return scoped
    ? JSON.stringify(['scope', graphCwd, maxFiles, prefixes])
    : JSON.stringify(['root', graphCwd]);
}

// Keep the existing binary protocol while bounding Windows command-line size.
// Each invocation still resolves against the whole tree. Duplicate lightweight
// reused records are merged so relationship fields survive every chunk.
export async function _runGraphFilesChunked(
  absRoot,
  rels,
  reusedMetas,
  {
    maxArgChars = CODE_GRAPH_FILES_ARG_MAX_CHARS,
    runGraphFiles = _runGraphFiles,
  } = {},
) {
  const budget = Math.max(1, Math.floor(Number(maxArgChars) || CODE_GRAPH_FILES_ARG_MAX_CHARS));
  const chunks = [];
  let chunk = [];
  let chars = 0;
  for (const rel of Array.isArray(rels) ? rels : []) {
    const cost = String(rel).length + 3; // separator plus conservative quoting margin
    if (cost > budget) throw new Error(`code-graph relative path exceeds --files argument budget: ${rel}`);
    if (chunk.length && chars + cost > budget) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(rel);
    chars += cost;
  }
  if (chunk.length) chunks.push(chunk);

  const merged = new Map();
  for (const relChunk of chunks) {
    const records = await runGraphFiles(absRoot, relChunk, reusedMetas);
    for (const rec of Array.isArray(records) ? records : []) {
      if (!rec || typeof rec.rel !== 'string') continue;
      const previous = merged.get(rec.rel);
      if (!previous) {
        merged.set(rec.rel, rec);
        continue;
      }
      const next = { ...previous, ...rec };
      for (const field of ['resolvedImports', 'importedBy']) {
        next[field] = [...new Set([
          ...(Array.isArray(previous[field]) ? previous[field] : []),
          ...(Array.isArray(rec[field]) ? rec[field] : []),
        ])];
      }
      merged.set(rec.rel, next);
    }
  }
  return [...merged.values()];
}

// Exported for the focused worker-protocol regression test.
export function _codeGraphWorkerFailure(message) {
  const error = typeof message?.error === 'string' ? message.error.trim() : '';
  return new Error(error || 'code-graph prewarm worker failed');
}

// Exported for the focused best-effort prewarm regression test.
export function _prewarmCodeGraph(cwd, build = buildCodeGraphAsync) {
  if (!cwd) return;
  // Reuse the buildCodeGraphAsync single-flight path. Fire-and-forget, and
  // best-effort: skip a fresh worker spawn when the child-spawn gate is busy
  // so this warm never queues ahead of real code_graph/find queries.
  build(cwd, null, { bestEffort: true }).catch(() => { /* best-effort */ });
}

export function prewarmCodeGraph(cwd) {
  _prewarmCodeGraph(cwd);
}

export function prewarmCodeGraphSymbols(cwd, symbols, { language = null } = {}) {
  if (!cwd) return;
  const wanted = (Array.isArray(symbols) ? symbols : [symbols])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  buildCodeGraphAsync(cwd, null, { bestEffort: true }).then((graph) => {
    if (!graph) return;
    for (const symbol of wanted) {
      try { _lookupCandidateNodes(graph, symbol, language); } catch { /* best-effort */ }
    }
  }).catch(() => { /* best-effort */ });
}

export function prewarmCodeGraphIfProject(cwd) {
  if (!cwd) return false;
  const root = _findDirProjectRoot(cwd);
  if (!root) return false;
  prewarmCodeGraph(root);
  return true;
}

export async function buildCodeGraphAsync(cwd, signal = null, {
  bestEffort = false,
  excludedProjectRoots = [],
  maxFiles = CODE_GRAPH_MAX_FILES,
} = {}) {
  if (signal?.aborted) throw new Error('aborted');
  const graphCwd = _canonicalGraphCwd(cwd);
  const prefixes = _normalizedExcludedPrefixes(graphCwd, excludedProjectRoots);
  const scoped = prefixes.length > 0 || maxFiles !== CODE_GRAPH_MAX_FILES;
  const scopeOptions = scoped ? { excludedProjectRoots, maxFiles, cache: false } : null;
  const inflightKey = _codeGraphInflightKey(graphCwd, { scoped, maxFiles, prefixes });
  const cached = _codeGraphCache.get(graphCwd);
  if (!scoped && cached?.graph && Date.now() - cached.ts < CODE_GRAPH_TTL_MS) {
    _touchCodeGraphCache(graphCwd);
    return cached.graph;
  }
  const existing = _inflightAsyncBuilds.get(inflightKey);
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
  // Non-competing prewarm: the signature-validation manifest also needs a
  // child-spawn slot, so warmers skip before either it or a Worker can queue.
  if (bestEffort && !childSpawnHasSpareCapacity()) return null;
  const _genAtStart = _getCodeGraphGen(graphCwd);
  const promise = (async () => {
    // Loading the compact disk manifest/one candidate entry is synchronous but
    // bounded I/O. Do not run a manifest at all when no disk candidate exists:
    // cold/dirty misses remain entirely on the existing Worker path.
    if (scoped) {
      return _spawnCodeGraphWorker(
        cwd, graphCwd, _genAtStart, signal, null, null, null,
        { buildOptions: scopeOptions, cacheResult: false },
      );
    }
    return _prepareDiskCodeGraphFastPath({
      graphCwd,
      runFastPath: (diskProbe) => _runDiskCodeGraphFastPath({
        graphCwd,
        diskProbe,
        genAtStart: _genAtStart,
        signal,
        loadDiskEntry: () => getDiskCodeGraphEntry(graphCwd),
        consumeDirty: () => _consumeCodeGraphDirtyPaths(graphCwd),
        spawnWorker: (preAcquiredRelease, manifest, signature) => _spawnCodeGraphWorker(
          cwd,
          graphCwd,
          _genAtStart,
          signal,
          preAcquiredRelease,
          manifest,
          signature,
        ),
      }),
    });
  })();
  _inflightAsyncBuilds.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    _inflightAsyncBuilds.delete(inflightKey);
  }
}

export function _spawnCodeGraphWorker(
  cwd,
  graphCwd,
  genAtStart,
  signal,
  preAcquiredRelease = null,
  manifest = null,
  signature = null,
  {
    // stdout/stderr captured: worker threads otherwise copy straight into the
    // real fds, bypassing the TUI stderr guard (terminal frame corruption).
    createWorker = (url, options) => new Worker(url, { ...options, stdout: true, stderr: true }),
    getGeneration = _getCodeGraphGen,
    setMemoryCache = _setCodeGraphCache,
    setDiskCache = _setDiskCodeGraphEntry,
    buildOptions = null,
    cacheResult = true,
  } = {},
) {
  let _worker = null;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    let _onSignalAbort = null;
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
      if (val instanceof Error) reject(val);
      else resolve(val);
    };
    (preAcquiredRelease ? Promise.resolve(preAcquiredRelease) : acquireChildSpawnSlot(signal || null)).then((release) => {
      _releaseSlot = release;
      if (settled) { release(); _releaseSlot = null; return; }
      if (signal?.aborted) { settle(new Error('aborted')); return; }
      const workerUrl = new URL('../code-graph-prewarm-worker.mjs', import.meta.url);
      try {
        _worker = createWorker(workerUrl, {
          workerData: { cwd, manifest, signature, buildOptions },
          execArgv: [],
        });
        _worker.stdout?.on?.('data', (chunk) => { try { process.stderr.write(chunk); } catch { /* best-effort */ } });
        _worker.stderr?.on?.('data', (chunk) => { try { process.stderr.write(chunk); } catch { /* best-effort */ } });
      } catch (e) {
        settle(e instanceof Error ? e : new Error(String(e)));
        return;
      }
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
            const genStillCurrent = getGeneration(graphCwd) === genAtStart;
            if (genStillCurrent && cacheResult) {
              setMemoryCache(graphCwd, { ts: Date.now(), signature: msg.signature, graph: msg.graph });
              setDiskCache(graphCwd, msg.graph);
            }
            settle(genStillCurrent ? msg.graph : new Error('code-graph build invalidated during prewarm'));
          } else {
            settle(_codeGraphWorkerFailure(msg));
          }
        } catch (e) { settle(e instanceof Error ? e : new Error(String(e))); }
      });
      w.once('error', (e) => settle(e instanceof Error ? e : new Error(String(e))));
    }, (e) => settle(e instanceof Error ? e : new Error(String(e))));
  });
}

/**
 * Internal — exported (via the facade) solely for code-graph-prewarm-worker.mjs
 * to import. NOT part of the public API. External callers should use
 * buildCodeGraphAsync (worker-thread isolated) or the code_graph / find_symbol
 * tools, never this synchronous form on the main event loop.
 */
export async function _buildCodeGraph(cwd, {
  manifest: suppliedManifest = null,
  signature: suppliedSignature = null,
  excludedProjectRoots = [],
  maxFiles = CODE_GRAPH_MAX_FILES,
  cache = true,
} = {}) {
  const now = Date.now();
  let _tp = performance.now();
  const _trace = (label) => { if (process.env.MIXDOG_GRAPH_TRACE) { const n = performance.now(); process.stderr.write(`[cg-trace] ${label}=${(n - _tp).toFixed(0)}ms\n`); _tp = n; } };
  const graphCwd = _canonicalGraphCwd(cwd);
  const absRoot = graphCwd;
  const _genAtStart = _getCodeGraphGen(graphCwd);
  const cached = cache ? _codeGraphCache.get(graphCwd) : null;
  let previousGraph = cached?.graph || null;
  if (cache) _consumeCodeGraphDirtyPaths(graphCwd);

  // 1. Change-detect via Rust --manifest (fp/rel/size only, no parse). A
  // main-thread disk-cache validation may hand its just-computed manifest to
  // this Worker after a miss, avoiding a duplicate native process.
  const unscopedManifest = Array.isArray(suppliedManifest) ? suppliedManifest : await _runGraphManifest(absRoot);
  const scoped = _scopeCodeGraphManifest(unscopedManifest, absRoot, { excludedProjectRoots, maxFiles });
  const manifest = scoped.manifest;
  const signature = typeof suppliedSignature === 'string'
    ? suppliedSignature
    : _computeGraphSignature(manifest);
  if (!Array.isArray(suppliedManifest)) _trace('manifest+sig');
  const { truncated, indexed } = scoped;

  // 2. Memory cache hit.
  if (cached && cached.signature === signature && now - cached.ts < CODE_GRAPH_TTL_MS) {
    _touchCodeGraphCache(graphCwd);
    return cached.graph;
  }

  // 3. Disk cache hit.
  if (cache) ensureDiskCodeGraphLoaded(now);
  const diskEntry = cache ? getDiskCodeGraphEntry(graphCwd) : null;
  if (_isCompatibleDiskCodeGraphEntry(diskEntry) && diskEntry.signature === signature) {
    const graph = _deserializeGraph(graphCwd, diskEntry);
    if (graph) {
      if (_getCodeGraphGen(graphCwd) === _genAtStart) {
        _setCodeGraphCache(graphCwd, { ts: now, signature, graph });
      }
      return graph;
    }
  }
  if (!previousGraph && _isCompatibleDiskCodeGraphEntry(diskEntry)) {
    previousGraph = _deserializeGraph(graphCwd, diskEntry);
  }
  if (previousGraph && previousGraph.schemaVersion !== SYMBOL_SCHEMA_VERSION) {
    previousGraph = null;
  }

  // 4. Build fileInfos. Reuse unchanged nodes by fp; parse the rest in Rust.
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
    const recs = await _runGraphFilesChunked(absRoot, freshRels, reusable);
    const reusedByRel = new Map(reusable.map((info) => [info.rel, info]));
    const freshSet = new Set(freshRels);
    fileInfos = [...reusable];
    for (const rec of recs) {
      if (freshSet.has(rec.rel)) {
        fileInfos.push(_fileInfoFromRustRecord(rec, absRoot));
      } else {
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
  } else if (scoped.prefixes.length) {
    const recs = await _runGraphFilesChunked(absRoot, freshRels, reusable);
    fileInfos = recs.map((rec) => _fileInfoFromRustRecord(rec, absRoot));
  } else {
    let recs = await _runGraphWalk(absRoot);
    if (recs.length > maxFiles) recs = recs.slice(0, maxFiles);
    fileInfos = recs.map((rec) => _fileInfoFromRustRecord(rec, absRoot));
  }
  const allowedRels = new Set(indexed.map((meta) => meta.rel));
  for (const info of fileInfos) {
    info.resolvedImports = (info.resolvedImports || []).filter((rel) => allowedRels.has(rel));
    info.importedBy = [];
  }
  const importedBy = new Map(fileInfos.map((info) => [info.rel, []]));
  for (const info of fileInfos) {
    for (const targetRel of info.resolvedImports) {
      const sources = importedBy.get(targetRel);
      if (sources) sources.push(info.rel);
    }
  }
  for (const info of fileInfos) {
    info.importedBy = [...new Set(importedBy.get(info.rel) || [])];
  }
  _trace('walk+parse');
  const nodes = new Map();
  const reverse = new Map();
  for (const info of fileInfos) {
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
    for (const rel of resolvedImportsRel) {
      if (!reverse.has(rel)) reverse.set(rel, new Set());
      reverse.get(rel).add(node.rel);
    }
  }
  _trace('assemble');
  const graph = _attachGraphRuntimeCaches({ cwd: graphCwd, nodes, reverse, schemaVersion: SYMBOL_SCHEMA_VERSION, builtAt: now, signature });
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
  if (cache && _getCodeGraphGen(graphCwd) === _genAtStart) {
    _setCodeGraphCache(graphCwd, { ts: now, signature, graph });
    _setDiskCodeGraphEntry(graphCwd, graph);
    _trace('cache+disk');
  }
  return graph;
}
