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
import { resolve as pathResolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { acquire as acquireChildSpawnSlot } from '../../../../shared/child-spawn-gate.mjs';
import {
  canonicalGraphCwd as _canonicalGraphCwd,
  codeGraphCache as _codeGraphCache,
  consumeCodeGraphDirtyPaths as _consumeCodeGraphDirtyPaths,
  getCodeGraphGen as _getCodeGraphGen,
} from '../code-graph-state.mjs';
import {
  CODE_GRAPH_TTL_MS,
  CODE_GRAPH_MAX_FILES,
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
  getDiskCodeGraphEntry,
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

export function prewarmCodeGraph(cwd) {
  if (!cwd) return;
  // Reuse the buildCodeGraphAsync single-flight path. Fire-and-forget.
  buildCodeGraphAsync(cwd).catch(() => { /* best-effort */ });
}

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
  const cached = _codeGraphCache.get(graphCwd);
  if (cached?.graph && Date.now() - cached.ts < CODE_GRAPH_TTL_MS) {
    _touchCodeGraphCache(graphCwd);
    return cached.graph;
  }
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
  const _genAtStart = _getCodeGraphGen(graphCwd);
  let _worker = null;
  const promise = new Promise((resolve, reject) => {
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
      _inflightAsyncBuilds.delete(graphCwd);
      if (val instanceof Error) reject(val);
      else resolve(val);
    };
    acquireChildSpawnSlot(signal || null).then((release) => {
      _releaseSlot = release;
      if (settled) { release(); _releaseSlot = null; return; }
      const workerUrl = new URL('../code-graph-prewarm-worker.mjs', import.meta.url);
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
            if (_getCodeGraphGen(graphCwd) === _genAtStart) {
              _setCodeGraphCache(graphCwd, { ts: Date.now(), signature: msg.signature, graph: msg.graph });
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

/**
 * Internal — exported (via the facade) solely for code-graph-prewarm-worker.mjs
 * to import. NOT part of the public API. External callers should use
 * buildCodeGraphAsync (worker-thread isolated) or the code_graph / find_symbol
 * tools, never this synchronous form on the main event loop.
 */
export async function _buildCodeGraph(cwd) {
  const now = Date.now();
  let _tp = performance.now();
  const _trace = (label) => { if (process.env.MIXDOG_GRAPH_TRACE) { const n = performance.now(); process.stderr.write(`[cg-trace] ${label}=${(n - _tp).toFixed(0)}ms\n`); _tp = n; } };
  const graphCwd = _canonicalGraphCwd(cwd);
  const absRoot = graphCwd;
  const _genAtStart = _getCodeGraphGen(graphCwd);
  const cached = _codeGraphCache.get(graphCwd);
  let previousGraph = cached?.graph || null;
  _consumeCodeGraphDirtyPaths(graphCwd);

  // 1. Change-detect via Rust --manifest (fp/rel/size only, no parse).
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
  ensureDiskCodeGraphLoaded(now);
  const diskEntry = getDiskCodeGraphEntry(graphCwd);
  if (diskEntry?.signature === signature) {
    const graph = _deserializeGraph(graphCwd, diskEntry);
    if (graph) {
      if (_getCodeGraphGen(graphCwd) === _genAtStart) {
        _setCodeGraphCache(graphCwd, { ts: now, signature, graph });
      }
      return graph;
    }
  }
  if (!previousGraph && diskEntry) previousGraph = _deserializeGraph(graphCwd, diskEntry);
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
    const recs = await _runGraphFiles(absRoot, freshRels, reusable);
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
  } else {
    let recs = await _runGraphWalk(absRoot);
    if (recs.length > CODE_GRAPH_MAX_FILES) recs = recs.slice(0, CODE_GRAPH_MAX_FILES);
    fileInfos = recs.map((rec) => _fileInfoFromRustRecord(rec, absRoot));
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
  if (_getCodeGraphGen(graphCwd) === _genAtStart) {
    _setCodeGraphCache(graphCwd, { ts: now, signature, graph });
    _setDiskCodeGraphEntry(graphCwd, graph);
    _trace('cache+disk');
  }
  return graph;
}
