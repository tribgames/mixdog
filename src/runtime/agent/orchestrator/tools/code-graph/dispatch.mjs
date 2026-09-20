// Tool dispatch layer: codeGraph (mode router), findSymbolTool,
// executeCodeGraphTool (entry with cwd re-rooting + batch fan-out + abort
// race), isCodeGraphTool. The per-mode answers live under modes/
// (structure, dependents, symbols, calls); codeGraph resolves the graph and
// the file/directory anchor once and hands that context to the mode.
//
//   dispatch/federation.mjs      — multi-root fan-out from a non-project cwd
//   dispatch/root-resolution.mjs — which project root a single call indexes
//   dispatch/work.mjs            — mode router with symbols[]/files[] batching
//   dispatch/abort-race.mjs      — settle work or reject on the caller's abort

import { resolve as pathResolve, isAbsolute, relative as pathRelative, dirname as pathDirname } from 'node:path';

import { statSync } from 'node:fs';
import { normalizeInputPath } from '../builtin/path-utils.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../code-graph-tool-defs.mjs';
import { CODE_GRAPH_OUTPUT_MAX_BYTES, capLineOrientedToolOutput } from '../builtin/tool-output-limit.mjs';
import { _graphRel, _appendSameBasenameHint } from './source-access.mjs';
import {
  _capGraphList,
  _symbolOutlineRows,
  _graphHasNativeSymbols,
  _graphExpectsNativeSymbols,
} from './symbol-index.mjs';
import { _findDirProjectRoot } from './project-root.mjs';
import { buildCodeGraphAsync, prewarmCodeGraph, prewarmCodeGraphSymbols } from './build.mjs';

import { _pruneCodeGraphMemoryCache } from './memory-cache.mjs';
import { _findSymbolAcrossGraph } from './search.mjs';
import { _graphHasAstCalls } from './ast-calls.mjs';
import { callsCapabilityError, symbolsCapabilityError, symbolsCapabilityHint } from './graph-binary.mjs';
import { hydrateGraphCallsFromSidecar } from './disk-cache.mjs';
import { _buildExactFileGraph, _pruneExactFileGraphCache } from './exact-file-graph.mjs';
import {
  _normalizeGraphFileArgs,
  _collectGraphFileList,
  _hasAggregateFileArgs,
  _aggregateAnchorsAreCwd,
  _resolveBoundedSentinelFreeAggregateRootForTest,
} from './aggregate-roots.mjs';
import { collectGraphSymbolList, outlineLanguageForPath } from './modes/shared.mjs';
import { overview, imports, related, impact } from './modes/structure.mjs';
import { dependents } from './modes/dependents.mjs';
import {
  filterSymbolOutline,
  findSymbol,
  prewarmPrimaryDeclaration,
  resolveOutsideDeclaration,
  symbols,
  symbolSearch,
} from './modes/symbols.mjs';
import { callees, callers, references } from './modes/calls.mjs';
import { _absFrom, planFederation, runFederation } from './dispatch/federation.mjs';
import {
  _isExistingDirectory,
  hasExplicitCwdArg,
  resolveAggregateAnchorRoot,
  resolveDirectoryRoot,
  resolveFileAnchorRoot,
} from './dispatch/root-resolution.mjs';
import { runCodeGraphWork } from './dispatch/work.mjs';
import { raceAbort } from './dispatch/abort-race.mjs';
// dispatch.test.mjs reaches the aggregate-root probe through this module.
export { _resolveBoundedSentinelFreeAggregateRootForTest };

// The modes that read AST call sites — the sidecar hydration trigger.
const CODE_GRAPH_CALL_MODES = new Set(['callers', 'callees', 'references']);
// …and the two that cannot answer at all without them. `references` still has
// non-call identifier usages to report, so it is not in this set.
const CODE_GRAPH_CALL_ONLY_MODES = new Set(['callers', 'callees']);
// …and the modes that cannot answer without native SYMBOLS. `overview` is not
// one of them: it still reports files, languages and imports, so it carries the
// capability hint instead of failing.
const CODE_GRAPH_SYMBOL_ONLY_MODES = new Set(['symbols', 'find_symbol', 'symbol_search']);
// The modes whose anchors are symbols; a `file`/`files` entry equal to the cwd
// is scope noise for them, not an anchor.
const CODE_GRAPH_SYMBOL_ANCHOR_MODES = new Set([
  'find_symbol',
  'symbol_search',
  'search',
  'references',
  'callers',
  'callees',
  'symbols',
]);

const CODE_GRAPH_MODES = {
  overview,
  imports,
  dependents,
  related,
  impact,
  callees,
  symbols,
  find_symbol: findSymbol,
  symbol_search: symbolSearch,
  references,
  callers,
};

/** The `file` argument normalized and made absolute against `cwd`; null when absent. */
function _absoluteFileArg(file, cwd) {
  const normFile = normalizeInputPath(file);
  return normFile ? _absFrom(cwd, normFile) : null;
}

/** `mode:'prewarm'`: queue the project (or symbol) prewarm and describe what was queued. */
function _schedulePrewarm(args, cwd) {
  const symbols = collectGraphSymbolList(args);
  if (symbols.length > 0) prewarmCodeGraphSymbols(cwd, symbols);
  else prewarmCodeGraph(cwd);
  const overflow = symbols.length > 5 ? `,+${symbols.length - 5}` : '';
  const detail = symbols.length ? ` (${symbols.slice(0, 5).join(',')}${overflow})` : '';
  return `prewarm scheduled: cwd=${cwd} symbols=${symbols.length}${detail}`;
}

/** A directory anchor as a `dir/` prefix over graph rels; null at the project root. */
function _scopeRelPrefix(graphRel) {
  const r = graphRel.replace(/\\/g, '/').replace(/\/+$/, '');
  return !r || r === '.' ? null : `${r}/`;
}

function _isExistingFile(abs) {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function collectGraphParseWarnings(graph, options) {
  for (const node of graph?.nodes?.values?.() || []) {
    if (!node.parseError) continue;
    options._parseWarnings?.set(node.abs, `${node.rel}: ${node.parseError}`);
    if (options.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
}

// `search` is an alias; name-only "symbols" calls (symbols[]/symbol without a
// file) are symbol lookups, not a file outline — absorb into symbol_search
// instead of erroring "file not found in graph: (missing file)".
function _resolveRequestedMode(args) {
  let mode = String(args?.mode || '').trim();
  if (!mode) throw new Error('code_graph: "mode" is required');
  if (mode === 'search') mode = 'symbol_search';
  const nameOnlySymbols =
    mode === 'symbols' &&
    !String(args?.file || '').trim() &&
    !String(args?.files || '').trim() &&
    ((Array.isArray(args?.symbols) && args.symbols.length) ||
      (typeof args?.symbols === 'string' && args.symbols.trim()) ||
      String(args?.symbol || '').trim());
  if (!nameOnlySymbols) return { mode, args };
  let nextArgs = args;
  if (!args.symbol && typeof args.symbols === 'string' && args.symbols.trim()) {
    nextArgs = { ...args, symbol: args.symbols };
    delete nextArgs.symbols;
  }
  return { mode: 'symbol_search', args: nextArgs };
}

// A file outline is source-local: it needs neither imports nor reverse
// edges. Index the explicit file alone (one binary run, cached by source
// hash) instead of waiting for a cold whole-project graph build — the
// outline is the native record here too, so this path and the full-graph
// path produce the same rows. Returns null when the outline must come from
// the full graph.
async function _exactFileOutline(args, cwd, signal) {
  const abs = _absoluteFileArg(args?.file, cwd);
  if (!abs || !outlineLanguageForPath(abs) || !_isExistingFile(abs)) return null;
  if (signal?.aborted) throw new Error('aborted');
  // The binary indexes paths UNDER its root, so a loose anchor outside cwd
  // (an absolute file in another tree) is rooted at its own directory —
  // one file either way, and the outline is identical.
  const relToCwd = pathRelative(pathResolve(cwd), abs);
  const insideCwd = !!relToCwd && !relToCwd.startsWith('..') && !isAbsolute(relToCwd);
  const outlineRoot = insideCwd ? cwd : pathDirname(abs);
  const exactGraph = await _buildExactFileGraph(outlineRoot, abs, signal);
  const exactNode = exactGraph?.nodes?.get(_graphRel(abs, outlineRoot));
  return exactNode ? filterSymbolOutline(exactNode, args) : null;
}

// The graph a mode answers from, with the capability gates applied.
async function _graphForMode(mode, cwd, signal, options) {
  const graph =
    options.graph ||
    (await buildCodeGraphAsync(cwd, signal, {
      excludedProjectRoots: options?.excludedProjectRoots,
    }));
  collectGraphParseWarnings(graph, options);
  if (!graph || graph.nodes.size === 0) {
    throw new Error(`code_graph: cwd '${cwd}' is not an indexed/known project root or contains zero eligible files`);
  }
  if (options?.scopedCacheOutcome && graph.truncated) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  // AST call sites live in a lazily loaded cache sidecar. Only the three modes
  // that read call sites pay for it, and only on the first such query of the
  // process (the graph object carries the marker); overview/symbols/imports/…
  // never touch the file.
  if (CODE_GRAPH_CALL_MODES.has(mode)) hydrateGraphCallsFromSidecar(graph);
  // Call analysis is AST-only: a graph without call data cannot answer, and an
  // empty answer would read like "no callers". Fail loudly with the remedy.
  if (CODE_GRAPH_CALL_ONLY_MODES.has(mode) && !_graphHasAstCalls(graph)) {
    throw callsCapabilityError(mode, cwd);
  }
  // The same rule for the outline half: symbols have no text fallback either.
  // A graph of extraction languages that carries no symbol record anywhere
  // cannot answer a symbol mode — say so instead of reporting "(no symbols)".
  // `overview` still has file/import structure to report, so it gets the
  // one-line hint rather than an error, exactly like `references`.
  if (CODE_GRAPH_SYMBOL_ONLY_MODES.has(mode) && !_graphHasNativeSymbols(graph) && _graphExpectsNativeSymbols(graph)) {
    throw symbolsCapabilityError(mode, cwd);
  }
  return graph;
}

export async function codeGraph(rawArgs, cwd, signal = null, options = {}) {
  const { mode, args } = _resolveRequestedMode(rawArgs);
  if (mode === 'prewarm') return _schedulePrewarm(args, cwd);
  if (mode === 'symbols' && !options.graph) {
    const outline = await _exactFileOutline(args, cwd, signal);
    if (outline !== null) return outline;
  }
  const handler = CODE_GRAPH_MODES[mode];
  if (!handler) throw new Error(`code_graph: unknown mode "${mode}"`);
  const graph = await _graphForMode(mode, cwd, signal, options);
  const symbolsNote =
    mode === 'overview' && !_graphHasNativeSymbols(graph) && _graphExpectsNativeSymbols(graph)
      ? `\n\nnote: no outline is shown for these files — ${symbolsCapabilityHint()}`
      : '';
  const normFile = normalizeInputPath(args?.file);
  const abs = normFile ? _absFrom(cwd, normFile) : null;
  const fileIsDirectory = abs ? _isExistingDirectory(abs) : false;
  const rel = abs && !fileIsDirectory ? _graphRel(abs, cwd) : null;
  const scopeRelPrefix = abs && fileIsDirectory ? _scopeRelPrefix(_graphRel(abs, cwd)) : null;
  const node = rel ? graph.nodes.get(rel) : null;
  return handler({
    args, cwd, defaultCwd: options._defaultCwd ?? cwd,
    signal, graph, normFile, rel, node, scopeRelPrefix, symbolsNote,
  });
}

async function findSymbolTool(args, cwd, signal = null, options = {}) {
  if (args?.mode === 'prewarm') return _schedulePrewarm(args, cwd);
  const normFile = normalizeInputPath(args?.file);
  const abs = normFile ? _absFrom(cwd, normFile) : null;
  const exactFile = Boolean(abs && outlineLanguageForPath(abs) && _isExistingFile(abs));
  const graph = exactFile
    ? await _buildExactFileGraph(cwd, abs, signal)
    : await buildCodeGraphAsync(cwd, signal, {
        excludedProjectRoots: options?.excludedProjectRoots,
      });
  if (!graph)
    throw new Error(`find_symbol: cwd '${cwd}' is not an indexed/known project root or contains zero eligible files`);
  collectGraphParseWarnings(graph, options);
  // Symbol lookups have no text fallback (see codeGraph above). An exact-file
  // graph is exempt: one file that declares nothing is an answer, not a
  // missing capability.
  if (!exactFile && !_graphHasNativeSymbols(graph) && _graphExpectsNativeSymbols(graph)) {
    throw symbolsCapabilityError('find_symbol', cwd);
  }
  if (options?.scopedCacheOutcome && graph.truncated) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  const symbol = String(args?.symbol || '').trim();
  const language = String(args?.language || '').trim() || null;
  const limit = Math.max(1, Math.min(50, Number(args?.limit || 20)));
  const fileRel = abs ? _graphRel(abs, cwd) : null;
  if (fileRel && !graph.nodes.get(fileRel)) {
    return _appendSameBasenameHint(`Error: find_symbol: file not found in graph: ${normFile}`, normFile, graph);
  }
  if (!symbol) {
    if (fileRel) {
      // Same rows as code_graph symbols: the native record, nested by parent.
      const items = _symbolOutlineRows(graph.nodes.get(fileRel));
      return items.length ? _capGraphList(items).join('\n') : '(no symbols)';
    }
    throw new Error('find_symbol: provide "symbol" (to locate) or "file" (to list its symbols).');
  }
  if (args?.body !== false) await prewarmPrimaryDeclaration(graph, symbol, language, signal);
  return _findSymbolAcrossGraph(graph, symbol, cwd, {
    defaultCwd: options._defaultCwd ?? cwd,
    language,
    limit,
    fileRel,
    body: args?.body !== false,
    outsideDeclaration: await resolveOutsideDeclaration(graph, symbol, {
      language,
      fileRel,
      signal,
    }),
  });
}

/** Symbol-mode calls anchored at the cwd itself carry no file anchor. */
function _dropCwdAnchors(args, baseCwd) {
  if (!CODE_GRAPH_SYMBOL_ANCHOR_MODES.has(args?.mode)) return args;
  let next = args;
  if (
    typeof next?.file === 'string' &&
    next.file.trim() &&
    pathResolve(baseCwd, next.file.trim()) === pathResolve(baseCwd)
  ) {
    next = { ...next };
    delete next.file;
  }
  if (_aggregateAnchorsAreCwd(next, baseCwd)) {
    next = { ...next };
    delete next.files;
    delete next.file;
  }
  return next;
}

async function executeCodeGraphToolRaw(name, rawArgs, cwd, signal = null, options = {}) {
  if (!cwd) throw new Error('find_symbol/code_graph requires cwd — caller did not provide a working directory');
  const normalized = _normalizeGraphFileArgs(rawArgs);
  const baseCwd = hasExplicitCwdArg(normalized) ? normalized.cwd.trim() : cwd;
  let args = _dropCwdAnchors(normalized, baseCwd);
  const fileArg = typeof args?.file === 'string' && args.file.trim() ? args.file.trim() : '';
  const hasAggregateFileArgs = _hasAggregateFileArgs(args);
  // An explicit `cwd` argument is a deliberate target: honour whatever root it
  // resolves to. A session cwd is a guess, so its ancestor walk stops at the
  // home/temp boundary instead of adopting a stray sentinel found there.
  const explicitCwdArg = hasExplicitCwdArg(args);
  const baseProjectRoot = _findDirProjectRoot(baseCwd, { stopAtUserBoundary: !explicitCwdArg });
  const plan = planFederation(args, baseCwd, { baseProjectRoot, fileArg, hasAggregateFileArgs });
  if (plan.active) {
    const federated = runFederation(name, args, plan, baseCwd, signal, options, executeCodeGraphTool);
    if (federated !== null) return federated;
  }
  let effectiveCwd = baseCwd;
  if (hasAggregateFileArgs && !baseProjectRoot) {
    const resolved = resolveAggregateAnchorRoot(name, args, baseCwd, { explicitCwdArg });
    effectiveCwd = resolved.effectiveCwd;
    args = resolved.args;
  }
  if (fileArg && !hasAggregateFileArgs) {
    const anchor = resolveFileAnchorRoot(name, args, fileArg, baseCwd);
    if (anchor.error) return anchor.error;
    if (anchor.root) effectiveCwd = anchor.root;
  }
  if (!fileArg && !explicitCwdArg) {
    effectiveCwd = resolveDirectoryRoot(name, effectiveCwd, { filesystemRootCwd: plan.filesystemRootCwd });
  }
  if (signal?.aborted) throw new Error('aborted');
  const work = runCodeGraphWork(name, args, effectiveCwd, signal, { ...options, _defaultCwd: cwd }, { findSymbolTool, codeGraph }).finally(
    () => {
      _pruneCodeGraphMemoryCache();
      _pruneExactFileGraphCache();
    }
  );
  return raceAbort(work, signal);
}

function _codeGraphBudgetFooter(args, keptLines) {
  const rawMode = String(args?.mode || '').trim();
  const capKb = Math.round(CODE_GRAPH_OUTPUT_MAX_BYTES / 1024);
  const targets = collectGraphSymbolList(args);
  const files = _collectGraphFileList(args, { cap: false });
  const batchTargets = targets.length ? targets : files;
  const label = targets.length ? 'symbols' : 'files';
  let currentIndex = 0;
  if (batchTargets.length > 1) {
    const header = new RegExp(`^# (?:${rawMode === 'search' ? 'symbol_search' : rawMode}) (.+)$`);
    for (const line of keptLines) {
      const match = header.exec(line);
      if (!match) continue;
      const index = batchTargets.indexOf(match[1]);
      if (index >= 0) currentIndex = index;
    }
    return `... [code_graph output capped at ${capKb} KB; not fully shown: ${label}=${JSON.stringify(batchTargets.slice(currentIndex))}]`;
  }
  const target = batchTargets[0];
  const targetTail = target
    ? `; remainder for ${label.slice(0, -1)}=${JSON.stringify(target)} omitted`
    : '; remainder omitted';
  return `... [code_graph output capped at ${capKb} KB${targetTail}]`;
}

export async function executeCodeGraphTool(name, args, cwd, signal = null, options = {}) {
  const warnings = new Map();
  const raw = await executeCodeGraphToolRaw(name, args, cwd, signal, { ...options, _parseWarnings: warnings });
  const result = warnings.size
    ? `[warning] ${warnings.size} source file(s) could not be indexed; graph results are partial:\n` +
      [...warnings.values()].slice(0, 5).join('\n') +
      `\n${raw}`
    : raw;
  return capLineOrientedToolOutput(result, CODE_GRAPH_OUTPUT_MAX_BYTES, (kept) => _codeGraphBudgetFooter(args, kept));
}

export function isCodeGraphTool(name) {
  return CODE_GRAPH_TOOL_DEFS.some((t) => t.name === name);
}
