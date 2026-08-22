// Tool dispatch layer: codeGraph (mode router), findSymbolTool,
// executeCodeGraphTool (entry with cwd re-rooting + batch fan-out + abort
// race), isCodeGraphTool. Extracted verbatim from code-graph.mjs.
import { resolve as pathResolve, isAbsolute, relative as pathRelative, basename as pathBasename, extname } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { normalizeInputPath, toDisplayPath } from '../builtin.mjs';
import { findFileByBasename } from '../builtin/path-diagnostics.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../code-graph-tool-defs.mjs';
import {
  CODE_GRAPH_OUTPUT_MAX_BYTES,
  capLineOrientedToolOutput,
} from '../builtin/tool-output-limit.mjs';
import { CODE_GRAPH_MAX_FILES } from './constants.mjs';
import { _graphRel, _getSourceTextForNode, _appendSameBasenameHint } from './source-access.mjs';
import {
  _extractSymbolsCheap,
  _buildExplainerFileSummary,
  _collectCheapSymbols,
  _capGraphList,
} from './symbol-index.mjs';
import {
  _PROJECT_ROOT_SENTINELS,
  _resolveFileProjectRoot,
  _findDirProjectRoot,
  _childProjectRoots,
  _stripEmptyArgs,
} from './project-root.mjs';
import { buildCodeGraphAsync, prewarmCodeGraph, prewarmCodeGraphSymbols } from './build.mjs';
import { _fileInfoFromRustRecord, _runGraphFiles } from './graph-binary.mjs';
import { _attachGraphRuntimeCaches } from './graph-model.mjs';
import {
  _isFilesystemRootPath,
  collectTrustedCodeGraphRoots,
  formatFederatedProjectLabel,
  owningTrustedCodeGraphRoot,
} from './trusted-roots.mjs';
import {
  _findSymbolHits,
  _findSymbolAcrossGraph,
  _searchSymbolsByKeyword,
  _extractCallees,
  _formatCalleeRow,
  _CALLEES_BRACE_LANGS,
  _formatRelated,
  _formatImpact,
  _impactSourceNodes,
  _resolveReferenceLanguageNode,
  _prewarmSourceTextNodes,
  _prewarmReferenceSourceText,
  _cheapReferenceSearch,
  _formatReferenceDetails,
  _formatCallerReferences,
  _formatTransitiveCallers,
  _augmentNoHitDiagnostic,
} from './search.mjs';

const CODE_GRAPH_BATCHABLE_MODES = new Set(['symbol', 'find_symbol', 'symbol_search', 'callers', 'callees', 'references']);
const CODE_GRAPH_FILE_BATCHABLE_MODES = new Set(['imports', 'dependents', 'related', 'impact', 'symbols', 'overview']);
const CODE_GRAPH_BATCH_CONCURRENCY = 20;

function _outlineLanguageForPath(file) {
  const ext = extname(String(file || '')).slice(1);
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'javascript';
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'typescript';
  if (ext === 'py') return 'python';
  if (ext === 'pyi') return 'python';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rust';
  if (ext === 'java') return 'java';
  if (ext === 'kt' || ext === 'kts') return 'kotlin';
  if (ext === 'cs') return 'csharp';
  if (ext === 'rb') return 'ruby';
  if (ext === 'php') return 'php';
  if (ext === 'swift') return 'swift';
  if (ext === 'c' || ext === 'h') return 'c';
  if (['cpp', 'cc', 'cxx', 'hpp', 'hxx'].includes(ext)) return 'cpp';
  if (ext === 'hh') return 'cpp';
  if (ext === 'scala' || ext === 'sc') return 'scala';
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return 'bash';
  if (ext === 'lua') return 'lua';
  if (ext === 'dart') return 'dart';
  if (ext === 'm' || ext === 'mm') return 'objc';
  if (ext === 'ex' || ext === 'exs') return 'elixir';
  if (ext === 'zig') return 'zig';
  if (ext === 'r' || ext === 'R') return 'r';
  return null;
}

const _exactFileGraphInflight = new Map();
const _exactFileGraphCache = new Map();
const EXACT_FILE_GRAPH_CACHE_MAX = 64;

async function _buildExactFileGraph(cwd, abs, signal = null) {
  const root = pathResolve(cwd);
  const file = pathResolve(abs);
  const rel = _graphRel(file, root);
  const key = `${root}\0${rel}`;
  const sourceText = await readFile(file, { encoding: 'utf8', signal: signal || undefined });
  const sourceHash = createHash('sha256').update(sourceText).digest('hex');
  const cached = _exactFileGraphCache.get(key);
  if (cached?.sourceHash === sourceHash) {
    _exactFileGraphCache.delete(key);
    _exactFileGraphCache.set(key, cached);
    return cached.graph;
  }
  const existing = _exactFileGraphInflight.get(key);
  if (existing?.sourceHash === sourceHash) return existing.promise;
  const pending = (async () => {
    const records = await _runGraphFiles(root, [rel], [], signal);
    const record = records.find((item) => _graphRel(pathResolve(root, item.rel), root) === rel);
    if (!record) return null;
    const info = _fileInfoFromRustRecord(record, root);
    const node = {
      abs: info.abs,
      rel: info.rel,
      lang: info.lang,
      fingerprint: info.fingerprint,
      rawImports: info.rawImports,
      resolvedImportsRel: [],
      resolvedImports: [],
      importedBy: [],
      packageName: info.packageName,
      namespaceName: info.namespaceName,
      goPackageName: info.goPackageName,
      topLevelTypes: info.topLevelTypes,
      tokenSymbols: info.tokenSymbols,
      symbols: Array.isArray(info.symbols) ? info.symbols : [],
    };
    const graph = _attachGraphRuntimeCaches({
      cwd: root,
      nodes: new Map([[node.rel, node]]),
      reverse: new Map(),
      builtAt: Date.now(),
      signature: info.fingerprint || '',
      truncated: false,
    });
    graph._sourceTextCache.set(node.rel, {
      fingerprint: node.fingerprint || '',
      text: sourceText,
    });
    _exactFileGraphCache.delete(key);
    _exactFileGraphCache.set(key, { sourceHash, graph });
    while (_exactFileGraphCache.size > EXACT_FILE_GRAPH_CACHE_MAX) {
      _exactFileGraphCache.delete(_exactFileGraphCache.keys().next().value);
    }
    return graph;
  })();
  const inflight = { sourceHash, promise: pending };
  _exactFileGraphInflight.set(key, inflight);
  try {
    return await pending;
  } finally {
    if (_exactFileGraphInflight.get(key) === inflight) _exactFileGraphInflight.delete(key);
  }
}

async function _mapWithConcurrency(values, mapper) {
  const out = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CODE_GRAPH_BATCH_CONCURRENCY, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      out[index] = await mapper(values[index], index);
    }
  }));
  return out;
}

function _collectGraphSymbolList(args) {
  const split = (s) => String(s || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  const list = [...new Set([
    ...(Array.isArray(args?.symbols) ? args.symbols.map((s) => String(s || '').trim()).filter(Boolean) : []),
    ...(typeof args?.symbols === 'string' ? split(args.symbols) : []),
    ...(typeof args?.symbol === 'string' ? split(args.symbol) : []),
  ])];
  return list;
}

// Filter BEFORE capping: the outline of a symbol-dense file exceeds the
// 200-entry cap, so filtering a pre-capped outline silently lost every
// late-file symbol AND the truncation marker itself — a requested symbol
// past the cap looked like "(no symbols matching …)" with no hint.
function _filterSymbolOutline(text, lang, args) {
  const keywords = _collectGraphSymbolList(args);
  const items = _collectCheapSymbols(text, lang)
    .map((item) => `${item.kind} ${item.name} (L${item.line})`);
  if (!items.length) return '(no symbols)';
  if (!keywords.length) return _capGraphList(items).join('\n');
  const needles = keywords.map((keyword) => keyword.toLowerCase());
  const lines = items.filter((line) => needles.some((needle) => line.toLowerCase().includes(needle)));
  return lines.length
    ? _capGraphList(lines).join('\n')
    : `(no symbols matching ${keywords.map((keyword) => JSON.stringify(keyword)).join(', ')})`;
}

const _AGGREGATE_FILE_WILDCARD_RE = /[*?[\]{}]/;
const ROOT_FEDERATED_MODES = new Set([
  'overview', 'symbol', 'find_symbol', 'symbol_search', 'search',
  'references', 'callers', 'callees', 'symbols', 'prewarm',
]);
// Fan-out cap when federation targets are DISCOVERED (immediate child project
// roots of a sentinel-free cwd) rather than registered. Bounds the cost of
// answering a query at a multi-repo parent; registered roots are unaffected.
const CODE_GRAPH_DISCOVERED_FEDERATION_CAP = (() => {
  const raw = parseInt(process.env.MIXDOG_CODE_GRAPH_FEDERATION_CAP ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
})();

export async function _runCodeGraphFederation(roots, runOne, projectArgs) {
  return Promise.all((roots || []).map(async (root) => {
    let body;
    try { body = await runOne(root, projectArgs); }
    catch (err) { body = `Error: ${err?.message || String(err)}`; }
    return `# project ${formatFederatedProjectLabel(root)}\n${body}`;
  }));
}

// Absorb: file/files arriving as a JSON-stringified array
// (file:"[\"a.mjs\",\"b.mjs\"]") — parse to a real array so the graph lookup
// batches per file instead of treating the JSON text as one (missing) path.
function _parseJsonArrayString(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter(Boolean);
  } catch { /* not JSON — leave untouched */ }
  return null;
}

function _normalizeGraphFileArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const fileArr = _parseJsonArrayString(args.file);
  const filesArr = _parseJsonArrayString(args.files);
  if (!fileArr && !filesArr) return args;
  const out = { ...args };
  if (fileArr) { out.files = Array.isArray(out.files) ? [...fileArr, ...out.files] : fileArr; delete out.file; }
  if (filesArr) out.files = filesArr;
  // Collapse a lone entry back to the single-file field for the fast path.
  if (Array.isArray(out.files) && out.files.length === 1 && !out.file && !filesArr) {
    out.file = out.files[0];
    delete out.files;
  }
  return out;
}

function _collectGraphFileList(args) {
  const split = (s) => String(s || '').split(/,+/).map((t) => t.trim()).filter(Boolean);
  return [...new Set([
    ...(Array.isArray(args?.files) ? args.files.map((f) => String(f || '').trim()).filter(Boolean) : []),
    ...(typeof args?.files === 'string' ? split(args.files) : []),
    ...(typeof args?.file === 'string' && args.file.trim() ? [args.file.trim()] : []),
  ])];
}

function _hasAggregateFileArgs(args) {
  return (Array.isArray(args?.files) && args.files.some((f) => String(f || '').trim()))
    || (typeof args?.files === 'string' && args.files.trim());
}

// Aggregate anchors that ALL resolve to the cwd itself ('.', './', the cwd
// path) add no scope — they mean "search here". Detected so the call can take
// the plain-cwd route, which adopts a sentinel-free single tree (a vendored
// reference checkout) as its own root while still refusing an unbounded or
// multi-project parent. Without this, `files:"."` turned every reference tree
// into a hard "not inside a project" refusal.
function _aggregateAnchorsAreCwd(args, baseCwd) {
  if (!_hasAggregateFileArgs(args)) return false;
  const files = _collectGraphFileList(args);
  if (files.length === 0) return false;
  return files.every((file) => {
    const trimmed = String(file || '').trim();
    if (!trimmed || _AGGREGATE_FILE_WILDCARD_RE.test(trimmed)) return false;
    try {
      return pathResolve(isAbsolute(trimmed) ? trimmed : pathResolve(baseCwd, trimmed)) === pathResolve(baseCwd);
    } catch { return false; }
  });
}

// An invalid caller cwd may be recovered for an explicit files aggregate only
// when every supplied anchor points at the same detectable project. Do not use
// the batch cap here: an omitted anchor could belong to another project.
function _resolveAggregateFileProjectRoot(args, baseCwd) {
  if (!_hasAggregateFileArgs(args)) return null;
  // Comma-delimited strings are parsed for normal batch dispatch, but are not
  // unambiguous enough to select a project root. JSON array strings have
  // already been normalized to an actual array above.
  if (typeof args?.files === 'string' && args.files.includes(',')) return null;
  const files = _collectGraphFileList(args);
  const roots = new Set();
  for (const file of files) {
    // Never infer a root from a glob-shaped anchor, including a literal file
    // whose name contains a glob metacharacter.
    if (_AGGREGATE_FILE_WILDCARD_RE.test(file)) return null;
    const abs = isAbsolute(file) ? pathResolve(file) : pathResolve(baseCwd, file);
    if (!existsSync(abs)) return null;
    let isDirectory = false;
    try { isDirectory = statSync(abs).isDirectory(); } catch { return null; }
    const root = isDirectory ? _findDirProjectRoot(abs) : _resolveFileProjectRoot(abs);
    if (!root) return null;
    roots.add(pathResolve(root));
  }
  if (roots.size === 0) return null;
  if (roots.size === 1) return [...roots][0];
  // Monorepo anchors legitimately resolve to DIFFERENT sentinels: a workspace
  // package (apps/desktop/package.json) is nearer than the repo root, so one
  // call spanning `apps/desktop/...` and `src/...` yields two roots even though
  // both live in exactly one project. When one candidate contains every other,
  // that outermost root IS the single detectable project — adopt it instead of
  // refusing. Genuinely unrelated trees share no such candidate and still fail.
  return _outermostContainingRoot([...roots]);
}

export function _resolveBoundedSentinelFreeAggregateRootForTest(args, baseCwd) {
  if (!_hasAggregateFileArgs(args)) return null;
  const base = pathResolve(baseCwd);
  if (_isFilesystemRootPath(base) || base === pathResolve(osHomedir())) return null;
  try {
    if (!statSync(base).isDirectory()) return null;
  } catch {
    return null;
  }
  if (_childProjectRoots(base, { cap: 2 }).length > 0) return null;
  const files = _collectGraphFileList(args);
  if (files.length === 0) return null;
  for (const file of files) {
    if (_AGGREGATE_FILE_WILDCARD_RE.test(file)) return null;
    const abs = isAbsolute(file) ? pathResolve(file) : pathResolve(base, file);
    if (!existsSync(abs)) return null;
    const rel = pathRelative(base, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
  }
  return base;
}

// The candidate that contains (or equals) every other candidate, else null.
// Only an EXISTING candidate can win: a bare common ancestor that has no
// sentinel of its own is never adopted as a project root.
function _outermostContainingRoot(roots) {
  for (const candidate of roots) {
    if (roots.every((root) => _isSameOrInside(root, candidate))) return candidate;
  }
  return null;
}

function _isSameOrInside(child, parent) {
  try {
    const rel = pathRelative(pathResolve(parent), pathResolve(child));
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

// Aggregate recovery resolves relative anchors against the caller's original
// cwd. Keep those resolved paths when dispatching under the recovered root;
// otherwise codeGraph resolves them a second time below that root.
function _absolutizeAggregateFileArgs(args, baseCwd) {
  const absolutize = (file) => {
    const trimmed = String(file || '').trim();
    return trimmed && !isAbsolute(trimmed) ? pathResolve(baseCwd, trimmed) : file;
  };
  return {
    ...args,
    file: typeof args?.file === 'string' ? absolutize(args.file) : args?.file,
    files: Array.isArray(args?.files)
      ? args.files.map(absolutize)
      : (typeof args?.files === 'string' ? absolutize(args.files) : args?.files),
  };
}

async function codeGraph(args, cwd, signal = null, options = {}) {
  let mode = String(args?.mode || '').trim();
  if (!mode) throw new Error('code_graph: "mode" is required');
  if (mode === 'search') mode = 'symbol_search';
  // Name-only "symbols" calls (symbols[]/symbol without a file) are symbol
  // lookups, not a file outline — absorb into symbol_search instead of
  // erroring "file not found in graph: (missing file)".
  if (mode === 'symbols'
      && !String(args?.file || '').trim()
      && !String(args?.files || '').trim()
      && ((Array.isArray(args?.symbols) && args.symbols.length)
        || (typeof args?.symbols === 'string' && args.symbols.trim())
        || String(args?.symbol || '').trim())) {
    if (!args.symbol && typeof args.symbols === 'string' && args.symbols.trim()) {
      args = { ...args, symbol: args.symbols };
      delete args.symbols;
    }
    mode = 'symbol_search';
  }

  if (mode === 'prewarm') {
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

  // A file outline is source-local: it needs neither imports nor reverse
  // edges. Read the explicit file directly instead of waiting for a cold
  // whole-project graph build. Relationship and name-search modes keep the
  // full graph path below.
  if (mode === 'symbols') {
    const normFile = normalizeInputPath(args?.file);
    const abs = normFile
      ? (isAbsolute(normFile) ? pathResolve(normFile) : pathResolve(cwd, normFile))
      : null;
    const lang = abs ? _outlineLanguageForPath(abs) : null;
    if (abs && lang) {
      if (signal?.aborted) throw new Error('aborted');
      try {
        const text = await readFile(abs, { encoding: 'utf8', signal: signal || undefined });
        return _filterSymbolOutline(text, lang, args);
      } catch (error) {
        if (signal?.aborted) throw new Error('aborted');
        if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR') throw error;
      }
    }
  }

  const graph = await buildCodeGraphAsync(cwd, signal, {
    excludedProjectRoots: options?.excludedProjectRoots,
  });
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
    if (node) return _buildExplainerFileSummary(node, graph, cwd, { depth: args?.depth });
    // A directory anchor is a SCOPE: counting the whole repository under it
    // reported totals the caller never asked for.
    const scopedNodes = scopeRelPrefix
      ? [...graph.nodes.values()].filter((n) => n.rel === scopeRelPrefix.slice(0, -1)
        || n.rel.startsWith(scopeRelPrefix))
      : [...graph.nodes.values()];
    if (scopeRelPrefix && scopedNodes.length === 0) {
      return `(no indexed files under ${scopeRelPrefix})`;
    }
    const byLang = new Map();
    for (const node of scopedNodes) {
      byLang.set(node.lang, (byLang.get(node.lang) || 0) + 1);
    }
    const lines = [
      ...(scopeRelPrefix ? [`scope\t${scopeRelPrefix}`] : []),
      `files\t${scopedNodes.length}`,
      `edges\t${scopedNodes.reduce((sum, n) => sum + n.resolvedImports.length, 0)}`,
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
    let depRel = rel;
    let depNorm = normFile;
    let subNote = null;
    // (1) Symbol inference runs ONLY when no `file` arg was supplied at all —
    // an explicit file (even a directory that yields no rel) is never overridden.
    if (!depRel && !normFile) {
      const symCandidates = [
        ...(Array.isArray(args?.symbols) ? args.symbols : []),
        args?.symbol,
      ].map((s) => String(s || '').trim()).filter(Boolean);
      const KNOWN_SRC_EXT = /\.(mjs|cjs|js|jsx|mts|cts|ts|tsx|json|py|pyi|go|rb|rs|java|kt|kts|c|h|cc|cpp|cxx|hpp|hxx|hh|cs|php|swift|scala|sc|sh|bash|zsh|lua|dart|m|mm|ex|exs|zig|r)$/i;
      // (2) Symbol lookup FIRST — dotted names (e.g. obj.method) resolve here
      // before any path classification.
      for (const s of symCandidates) {
        const hits = _findSymbolHits(graph, s, {});
        const usable = hits.filter((h) => graph.nodes.get(h.rel));
        const pool = usable.length ? usable : hits;
        if (!pool.length) continue;
        // (3) Deterministic pick: defining hit, else first by sorted rel.
        const sorted = [...pool].sort((a, b) => String(a.rel).localeCompare(String(b.rel)));
        const primary = sorted.find((h) => h.declarationLike) || sorted[0];
        depRel = primary.rel; depNorm = primary.rel;
        subNote = `# note: dependents resolved from symbol '${s}' → ${primary.rel}`;
        const others = [...new Set(sorted.map((h) => h.rel))].filter((r) => r !== primary.rel);
        if (others.length) subNote += `\n# note: '${s}' also defined in: ${others.join(', ')}`;
        break;
      }
      // Path-classification only when the value has a slash or a known source
      // extension — never for plain dotted symbol names.
      if (!depRel) {
        const pathLike = symCandidates.find((s) => /[\\/]/.test(s) || KNOWN_SRC_EXT.test(s));
        if (pathLike) {
          const pAbs = isAbsolute(pathLike) ? pathResolve(pathLike) : pathResolve(cwd, pathLike);
          const pRel = _graphRel(pAbs, cwd);
          if (graph.nodes.get(pRel)) {
            depRel = pRel; depNorm = pathLike;
            subNote = `# note: treated symbol '${pathLike}' as file`;
          }
        }
      }
      // (4) Nothing resolved → actionable hint naming the attempted values,
      // with a distinct message when no symbol was supplied at all.
      if (!depRel) {
        throw new Error(symCandidates.length
          ? `code_graph dependents: dependents needs file:<path>; got symbol only (tried: ${symCandidates.join(', ')})`
          : 'code_graph dependents: "file" is required (no file or symbol supplied)');
      }
    }
    const depFileNode = depRel ? graph.nodes.get(depRel) : null;
    if (!depFileNode) return _appendSameBasenameHint(`Error: code_graph dependents: file not found in graph: ${depNorm || '(missing file)'}`, depNorm, graph);
    const GRAPH_LIST_CAP = 200;
    const depsAll = [...(graph.reverse.get(depRel) || [])].sort();
    if (!depsAll.length) return '(no dependents)';
    const deps = depsAll.slice(0, GRAPH_LIST_CAP);
    await _prewarmSourceTextNodes(
      graph,
      deps.map((dep) => graph.nodes.get(dep)).filter(Boolean),
      { signal },
    );
    const basename = depRel.split('/').pop();
    const stem = basename.replace(/\.[^/.]+$/, '');
    const enriched = deps.map((dep) => {
      const depNode = graph.nodes.get(dep);
      if (!depNode) return dep;
      const cached = graph._sourceTextCache?.get(depNode.rel);
      if (!cached || cached.fingerprint !== (depNode.fingerprint || '')) return dep;
      const text = cached.text;
      const linesArr = text.split(/\r?\n/);
      for (let i = 0; i < linesArr.length; i++) {
        const ln = linesArr[i];
        if (!/(?:^|\W)(?:import|require)\b|\bfrom\s*['"]/.test(ln)) continue;
        if (ln.includes(`/${basename}`) || ln.includes(`/${stem}`) || ln.includes(`'${basename}'`) || ln.includes(`"${basename}"`)) {
          return `${dep}:${i + 1}`;
        }
      }
      return dep;
    });
    const body = enriched.join('\n');
    const out = subNote ? `${subNote}\n${body}` : body;
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
    await _prewarmSourceTextNodes(graph, [node], { signal });
    await _prewarmSourceTextNodes(graph, _impactSourceNodes(node, graph, targetSymbol), { signal });
    return _formatImpact(node, graph, cwd, targetSymbol);
  }

  if (mode === 'callees') {
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
    await _prewarmSourceTextNodes(graph, [graph.nodes.get(declHit.rel)].filter(Boolean), { signal });
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
    await _prewarmSourceTextNodes(graph, [node], { signal });
    const cached = graph._sourceTextCache?.get(node.rel);
    return cached && cached.fingerprint === (node.fingerprint || '')
      ? _filterSymbolOutline(cached.text, node.lang, args)
      : '(no symbols)';
  }

  if (mode === 'find_symbol') {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) throw new Error('code_graph find_symbol: "symbol" is required.');
    const language = String(args?.language || '').trim() || null;
    const limit = Math.max(1, Math.min(50, Number(args?.limit || 20)));
    if (rel && !node) return _appendSameBasenameHint(`Error: code_graph find_symbol: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    if (args?.body !== false) {
      const hits = _findSymbolHits(graph, symbol, { language });
      const primary = hits.find((hit) => hit.declarationLike) || hits[0];
      await _prewarmSourceTextNodes(
        graph,
        [primary?.rel ? graph.nodes.get(primary.rel) : null].filter(Boolean),
        { signal },
      );
    }
    return _findSymbolAcrossGraph(graph, symbol, cwd, { language, limit, fileRel: rel, body: args?.body !== false });
  }

  if (mode === 'symbol_search') {
    const language = String(args?.language || '').trim() || null;
    const limit = Math.max(1, Math.min(100, Number(args?.limit || 30)));
    const symbolsList = Array.isArray(args?.symbols)
      ? args.symbols.map((s) => String(s || '').trim()).filter(Boolean)
      : [];
    const keyword = String(args?.symbol || '').trim();
    const keywords = symbolsList.length ? symbolsList : (keyword ? [keyword] : []);
    if (!keywords.length) throw new Error('code_graph symbol_search: "symbol" (or "symbols[]") is required.');
    // Native graph symbols answer without source text. Nodes lacking native
    // symbols fall back to cheap text extraction, so warm exactly that subset
    // asynchronously before the synchronous formatter scans it.
    await _prewarmSourceTextNodes(
      graph,
      [...graph.nodes.values()].filter((candidate) => !Array.isArray(candidate?.symbols) || candidate.symbols.length === 0),
      { signal },
    );
    // Honour the file/directory anchor: symbol_search used to scan the whole
    // graph even when the caller scoped the call.
    if (rel && !node) {
      return _appendSameBasenameHint(`Error: code_graph symbol_search: file not found in graph: ${normFile}`, normFile, graph);
    }
    if (keywords.length === 1) {
      return _searchSymbolsByKeyword(graph, keywords[0], cwd, { language, limit, fileRel: rel, scopeRelPrefix });
    }
    // Batch: merge results across symbols, dedupe identical result blocks.
    const seen = new Set();
    const sections = [];
    for (const kw of keywords) {
      const result = _searchSymbolsByKeyword(graph, kw, cwd, { language, limit, fileRel: rel, scopeRelPrefix });
      if (seen.has(result)) continue;
      seen.add(result);
      sections.push(`# symbol_search: ${kw}\n${result}`);
    }
    return sections.join('\n\n');
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
    if (node) await _prewarmSourceTextNodes(graph, [node], { signal });
    const resolved = _resolveReferenceLanguageNode(graph, symbol, rel, cwd, explicitLanguage);
    if (rel && resolved.kind === 'file-not-found') {
      return _appendSameBasenameHint(`Error: code_graph references: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    }
    if (rel && resolved.kind === 'symbol-not-present') {
      return `Error: code_graph references: symbol "${symbol}" not found in ${normFile || rel}`;
    }
    const resolvedNode = resolved.kind === 'ok' ? resolved.node : null;
    const lang = explicitLanguage
      || ((narrowedByCaller && resolvedNode) ? resolvedNode.lang : null);
    const rawLimit = Number(args?.limit);
    const userLimit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(500, Math.floor(rawLimit))
      : null;
    const _refNodes = await _prewarmReferenceSourceText(graph, symbol, lang, { signal });
    const refResult = _cheapReferenceSearch(graph, symbol, cwd, { language: lang, fileRel: rel, scopeRelPrefix, nodes: _refNodes });
    const detailedReferences = _formatReferenceDetails(graph, symbol, refResult, userLimit ? { limit: userLimit } : undefined);
    const references = narrowedByCaller ? detailedReferences : _augmentNoHitDiagnostic(detailedReferences, '(no references)', graph, cwd, symbol);
    const declaration = _findSymbolAcrossGraph(graph, symbol, cwd, {
      language: lang,
      limit: 1,
      fileRel: rel,
      body: args?.body === true,
    });
    return `# declaration\n${declaration}\n\n# references\n${references}`;
  }

  if (mode === 'callers') {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) throw new Error('code_graph callers: "symbol" is required.');
    const explicitLanguage = String(args?.language || '').trim() || null;
    if (explicitLanguage) {
      const langHasFiles = [...graph.nodes.values()].some((n) => n.lang === explicitLanguage);
      if (!langHasFiles) {
        throw new Error(`code_graph callers: language '${explicitLanguage}' has no adapter topLevelTypes and is not in supportedRegexLangs for this project`);
      }
    }
    const narrowedByCaller = Boolean(rel || scopeRelPrefix || explicitLanguage);
    if (node) await _prewarmSourceTextNodes(graph, [node], { signal });
    const resolved = _resolveReferenceLanguageNode(graph, symbol, rel, cwd, explicitLanguage);
    if (rel && resolved.kind === 'file-not-found') {
      return _appendSameBasenameHint(`Error: code_graph callers: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    }
    if (rel && resolved.kind === 'symbol-not-present') {
      return `Error: code_graph callers: symbol "${symbol}" not found in ${normFile || rel}`;
    }
    const resolvedNode = resolved.kind === 'ok' ? resolved.node : null;
    const lang = explicitLanguage
      || ((narrowedByCaller && resolvedNode) ? resolvedNode.lang : null);
    const rawLimit = Number(args?.limit);
    const userLimit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(500, Math.floor(rawLimit))
      : null;
    const _callerNodes = await _prewarmReferenceSourceText(graph, symbol, lang, { signal });
    const depth = Math.max(1, Math.min(5, Math.floor(Number(args?.depth) || 1)));
    if (depth > 1) {
      // Scope and limit are honoured at every level: a file/directory anchor
      // and an explicit limit used to be dropped for depth>1.
      return _formatTransitiveCallers(graph, symbol, cwd, {
        language: lang,
        depth,
        page: args?.page,
        fileRel: rel,
        scopeRelPrefix,
        ...(userLimit ? { pageSize: userLimit } : {}),
      });
    }
    const refs = _cheapReferenceSearch(graph, symbol, cwd, { language: lang, fileRel: rel, scopeRelPrefix, nodes: _callerNodes });
    const callerResult = _formatCallerReferences(graph, symbol, refs, userLimit ? { limit: userLimit } : undefined);
    return narrowedByCaller ? callerResult : _augmentNoHitDiagnostic(callerResult, '(no callers)', graph, cwd, symbol);
  }

  throw new Error(`code_graph: unknown mode "${mode}"`);
}

async function findSymbolTool(args, cwd, signal = null, options = {}) {
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
  const normFile = normalizeInputPath(args?.file);
  const abs = normFile ? (isAbsolute(normFile) ? pathResolve(normFile) : pathResolve(cwd, normFile)) : null;
  let exactFile = false;
  if (abs && _outlineLanguageForPath(abs)) {
    try { exactFile = statSync(abs).isFile(); } catch { exactFile = false; }
  }
  const graph = exactFile
    ? await _buildExactFileGraph(cwd, abs, signal)
    : await buildCodeGraphAsync(cwd, signal, {
        excludedProjectRoots: options?.excludedProjectRoots,
      });
  if (!graph) throw new Error(`find_symbol: cwd '${cwd}' is not an indexed/known project root or contains zero eligible files`);
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
      const node = graph.nodes.get(fileRel);
      await _prewarmSourceTextNodes(graph, [node], { signal });
      const cached = graph._sourceTextCache?.get(node.rel);
      return cached && cached.fingerprint === (node.fingerprint || '')
        ? _extractSymbolsCheap(cached.text, node.lang)
        : '(no symbols)';
    }
    throw new Error('find_symbol: provide "symbol" (to locate) or "file" (to list its symbols).');
  }
  if (args?.body !== false) {
    const hits = _findSymbolHits(graph, symbol, { language });
    const primary = hits.find((hit) => hit.declarationLike) || hits[0];
    await _prewarmSourceTextNodes(
      graph,
      [primary?.rel ? graph.nodes.get(primary.rel) : null].filter(Boolean),
      { signal },
    );
  }
  return _findSymbolAcrossGraph(graph, symbol, cwd, { language, limit, fileRel, body: args?.body !== false });
}

async function executeCodeGraphToolRaw(name, args, cwd, signal = null, options = {}) {
  if (!cwd) throw new Error('find_symbol/code_graph requires cwd — caller did not provide a working directory');
  args = _normalizeGraphFileArgs(args);
  const baseCwd = (args && typeof args.cwd === 'string' && args.cwd.trim()) ? args.cwd.trim() : cwd;
  const symbolMode = ['find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees', 'symbols'].includes(args?.mode);
  if (symbolMode && typeof args?.file === 'string' && args.file.trim()
      && pathResolve(baseCwd, args.file.trim()) === pathResolve(baseCwd)) {
    args = { ...args };
    delete args.file;
  }
  if (symbolMode && _aggregateAnchorsAreCwd(args, baseCwd)) {
    args = { ...args };
    delete args.files;
    delete args.file;
  }
  const fileArg = (args && typeof args.file === 'string' && args.file.trim()) ? args.file.trim() : '';
  const hasAggregateFileArgs = _hasAggregateFileArgs(args);
  let effectiveCwd = baseCwd;
  // An explicit `cwd` argument is a deliberate target: honour whatever root it
  // resolves to. A session cwd is a guess, so its ancestor walk stops at the
  // home/temp boundary instead of adopting a stray sentinel found there.
  const explicitCwdArg = !!(args && typeof args.cwd === 'string' && args.cwd.trim());
  const baseProjectRoot = _findDirProjectRoot(baseCwd, { stopAtUserBoundary: !explicitCwdArg });
  const filesystemRootCwd = !baseProjectRoot && _isFilesystemRootPath(baseCwd);
  const aggregateFilesAtBase = _collectGraphFileList(args);
  const rawModeAtBase = String(args?.mode || '').trim();
  const exactDotFederation = aggregateFilesAtBase.length === 1
    && aggregateFilesAtBase[0] === '.'
    && ROOT_FEDERATED_MODES.has(rawModeAtBase);
  const parentDotFederation = !baseProjectRoot
    && !filesystemRootCwd
    && exactDotFederation;
  // Trusted graph targets living UNDER a sentinel-free cwd. Self is filtered
  // out: federating a directory into itself would recurse forever.
  const trustedRootsAtBase = baseProjectRoot
    ? []
    : collectTrustedCodeGraphRoots(baseCwd)
      .filter((root) => pathResolve(root) !== pathResolve(baseCwd));
  // Trust registration is a ROUTING PREFERENCE, not an admission gate. A
  // sentinel-free cwd whose children are obvious project roots (a refs/ folder
  // of checkouts, a multi-repo parent) is answerable: federate over those
  // children instead of refusing the call. Cost stays bounded by the existing
  // per-project graph timeout and the federation fan-out cap — the same way the
  // reference CLIs bound a wide search (time/output caps, never a scope
  // refusal). Registered roots keep priority; discovered children only fill in
  // when registration yields nothing.
  const federationRootsAtBase = trustedRootsAtBase.length
    ? trustedRootsAtBase
    : (baseProjectRoot
      ? []
      : _childProjectRoots(baseCwd, { cap: CODE_GRAPH_DISCOVERED_FEDERATION_CAP })
        .filter((root) => pathResolve(root) !== pathResolve(baseCwd)));
  // A sentinel-free cwd (multi-repo parent, vendored reference tree) is still
  // routable when trusted project roots live under it — federate over those
  // instead of refusing the call outright.
  const sentinelFreeFederation = !baseProjectRoot
    && !filesystemRootCwd
    && !parentDotFederation
    && !fileArg
    && !hasAggregateFileArgs
    && ROOT_FEDERATED_MODES.has(rawModeAtBase)
    && federationRootsAtBase.length > 0;
  if (filesystemRootCwd || parentDotFederation || sentinelFreeFederation) {
    // A filesystem root stays on the REGISTERED set only: fanning out over
    // every project directory on a whole drive is a different cost class than
    // fanning out over one folder's children.
    const trustedRoots = filesystemRootCwd ? trustedRootsAtBase : federationRootsAtBase;
    const files = exactDotFederation ? [] : aggregateFilesAtBase;
    const rawMode = rawModeAtBase;
    const canFederate = files.length > 0 || ROOT_FEDERATED_MODES.has(rawMode);
    if (files.length) {
      if (files.some((file) => _AGGREGATE_FILE_WILDCARD_RE.test(file))) {
        return `Error: ${name}: wildcard-shaped file anchors are not allowed at a filesystem root`;
      }
      const routed = files.map((file) => {
        const abs = isAbsolute(file) ? pathResolve(file) : pathResolve(baseCwd, file);
        return {
          file,
          abs,
          exists: existsSync(abs),
          root: owningTrustedCodeGraphRoot(abs, trustedRoots),
        };
      });
      const missing = routed.find((row) => !row.exists);
      if (missing) return `Error: ${name}: file not found: ${missing.file}`;
      const untrusted = routed.find((row) => !row.root);
      if (untrusted) {
        return `Error: ${name}: file anchor is not owned by a trusted project: ${untrusted.file}`;
      }
      if (!canFederate) {
        return `Error: ${name}: mode '${rawMode}' cannot be routed from a filesystem root`;
      }
      const projectArgs = { ...args };
      delete projectArgs.cwd;
      const sections = await Promise.all(routed.map(async ({ file, abs, root }) => {
        const excludedProjectRoots = trustedRoots.filter((candidate) => candidate !== root
          && owningTrustedCodeGraphRoot(candidate, [root]) === root);
        let body;
        try {
          body = await executeCodeGraphTool(
            name,
            { ...projectArgs, file: abs, files: undefined },
            root,
            signal,
            { ...options, excludedProjectRoots },
          );
        } catch (err) {
          body = `Error: ${err?.message || String(err)}`;
        }
        return `# ${rawMode} ${file}\n# project ${formatFederatedProjectLabel(root)}\n${body}`;
      }));
      return sections.join('\n\n');
    }
    if (trustedRoots.length && canFederate) {
      const projectArgs = { ...args };
      delete projectArgs.cwd;
      if (exactDotFederation) {
        delete projectArgs.file;
        delete projectArgs.files;
      }
      const runOne = async (root, nextArgs) => executeCodeGraphTool(
        name,
        nextArgs,
        root,
        signal,
        {
          ...options,
          excludedProjectRoots: trustedRoots.filter((candidate) => candidate !== root
            && owningTrustedCodeGraphRoot(candidate, [root]) === root),
        },
      );
      const federationWork = _runCodeGraphFederation(trustedRoots, runOne, projectArgs)
        .then((sections) => sections.join('\n\n'));
      if (federationWork) {
        if (!signal) return federationWork;
        let onAbort = null;
        const abortP = new Promise((_, reject) => {
          if (signal.aborted) { reject(new Error('aborted')); return; }
          onAbort = () => reject(new Error('aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        });
        return Promise.race([federationWork, abortP]).finally(() => {
          if (onAbort) signal.removeEventListener('abort', onAbort);
        });
      }
    }
  }
  if (hasAggregateFileArgs && !baseProjectRoot) {
    const aggregateRoot = _resolveAggregateFileProjectRoot(args, baseCwd)
      || (explicitCwdArg ? _resolveBoundedSentinelFreeAggregateRootForTest(args, baseCwd) : null);
    if (!aggregateRoot) {
      throw new Error(
        `${name}: cwd '${baseCwd}' is not inside a project and aggregate file anchors do not all `
        + `exist under exactly one detectable project root. Refusing to index an arbitrary tree.`,
      );
    }
    effectiveCwd = aggregateRoot;
    args = _absolutizeAggregateFileArgs(args, baseCwd);
  }
  if (fileArg && !hasAggregateFileArgs) {
    const abs = isAbsolute(fileArg) ? pathResolve(fileArg) : pathResolve(baseCwd, fileArg);
    if (!existsSync(abs)) {
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
  if (!fileArg && !(args && typeof args.cwd === 'string' && args.cwd.trim())) {
    const projectRoot = _findDirProjectRoot(effectiveCwd, { stopAtUserBoundary: true });
    if (projectRoot) {
      effectiveCwd = projectRoot;
    } else {
      // A sentinel-free SINGLE tree (vendored reference checkout, script
      // folder) indexes as its own root — the same treatment an explicit
      // 'cwd' argument already gets. Only genuinely unbounded or ambiguous
      // targets stay refused: a filesystem root, the home directory, or a
      // parent holding several separate repositories.
      const childRoots = _childProjectRoots(effectiveCwd);
      // Non-null only when the sole sentinel sits at/above the home or temp
      // boundary — name it, so the refusal reads as a deliberate rule rather
      // than a missing project.
      const boundaryRoot = _findDirProjectRoot(effectiveCwd);
      const unbounded = filesystemRootCwd
        || _isFilesystemRootPath(effectiveCwd)
        || pathResolve(effectiveCwd) === pathResolve(osHomedir());
      if (unbounded || childRoots.length > 1) {
        const listed = childRoots.slice(0, 5).map((root) => `"${pathBasename(root)}"`).join(', ');
        throw new Error(
          `${name}: cwd '${effectiveCwd}' is not inside a project (no `
          + `${_PROJECT_ROOT_SENTINELS.join('/')} at it or any ancestor)`
          + `${childRoots.length > 1 ? ` and holds ${childRoots.length} separate project roots (${listed})` : ''}. `
          + `${boundaryRoot ? `The nearest sentinel is at '${boundaryRoot}' (home/temp), which is never auto-adopted. ` : ''}`
          + `Refusing to index an arbitrary tree. Run 'cwd set <repo>', or pass an explicit `
          + `'cwd' (repo root) or a 'file' anchor.`);
      }
    }
  }
  if (signal?.aborted) throw new Error('aborted');
  const _work = (() => {
    switch (name) {
      case 'code_graph': {
        // `body:true` asks for declaration bodies, which the outline-only
        // symbols mode cannot supply — it was silently ignored and models
        // fell back to large reads. Honor it via find_symbol, which batches
        // symbols[] and respects the file scope.
        if (String(args?.mode || '').trim() === 'symbols'
            && args?.body === true
            && _collectGraphSymbolList(args).length) {
          args = { ...args, mode: 'find_symbol' };
        }
        const rawMode = String(args?.mode || '').trim();
        const batchMode = rawMode === 'search' ? 'symbol_search' : rawMode;
        const declModes = new Set(['symbol', 'find_symbol']);
        const dispatchRaw = (a) => (declModes.has(rawMode)
          ? findSymbolTool(_stripEmptyArgs(a), effectiveCwd, signal, options)
          : codeGraph(a, effectiveCwd, signal, options));
        // `files` is documented as an optional SCOPE for the symbol modes, but
        // only the file-mode branch below normalized it — so find_symbol /
        // symbol_search / references / callers / callees silently answered for
        // the whole repository. Apply the scope here: a single entry becomes
        // the `file` anchor, several entries fan out per file.
        const symbolScopeFiles = (CODE_GRAPH_BATCHABLE_MODES.has(batchMode)
          && !(typeof args?.file === 'string' && args.file.trim()))
          ? _collectGraphFileList(args)
          : [];
        const dispatchOne = symbolScopeFiles.length === 0
          ? dispatchRaw
          : (symbolScopeFiles.length === 1
            ? (a) => dispatchRaw({ ...a, file: symbolScopeFiles[0], files: undefined })
            : async (a) => {
              const scoped = await _mapWithConcurrency(symbolScopeFiles, async (f) => {
                let body;
                try { body = await dispatchRaw({ ...a, file: f, files: undefined }); }
                catch (e) { body = `Error: ${e?.message || String(e)}`; }
                return `# file ${f}\n${body}`;
              });
              return scoped.join('\n\n');
            });
        if (CODE_GRAPH_BATCHABLE_MODES.has(batchMode)) {
          const symbolList = _collectGraphSymbolList(args);
          if (symbolList.length > 1) {
            return (async () => {
              const sections = await _mapWithConcurrency(symbolList, async (sym) => {
                let body;
                try { body = await dispatchOne({ ...args, symbol: sym, symbols: undefined }); }
                catch (e) { body = `Error: ${e?.message || String(e)}`; }
                return `# ${batchMode} ${sym}\n${body}`;
              });
              return sections.join('\n\n');
            })();
          }
          if (symbolList.length === 1 && args?.symbol !== symbolList[0]) {
            return dispatchOne({ ...args, symbol: symbolList[0], symbols: undefined });
          }
        }
        if (CODE_GRAPH_FILE_BATCHABLE_MODES.has(batchMode)) {
          const fileList = _collectGraphFileList(args);
          if (fileList.length > 1) {
            return (async () => {
              const sections = await _mapWithConcurrency(fileList, async (f) => {
                let body;
                try { body = await dispatchOne({ ...args, file: f, files: undefined }); }
                catch (e) { body = `Error: ${e?.message || String(e)}`; }
                return `# ${batchMode} ${f}\n${body}`;
              });
              return sections.join('\n\n');
            })();
          }
          if (fileList.length === 1 && args?.file !== fileList[0]) {
            return dispatchOne({ ...args, file: fileList[0], files: undefined });
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

function _codeGraphBudgetFooter(args, keptLines) {
  const rawMode = String(args?.mode || '').trim();
  const capKb = Math.round(CODE_GRAPH_OUTPUT_MAX_BYTES / 1024);
  const targets = _collectGraphSymbolList(args);
  const files = _collectGraphFileList(args, { cap: false });
  const batchTargets = targets.length ? targets : files;
  const label = targets.length ? 'symbols' : 'files';
  let currentIndex = 0;
  if (batchTargets.length > 1) {
    const header = new RegExp(`^# (?:${rawMode === 'search' ? 'symbol_search' : rawMode}) (.+)$`);
    for (const line of keptLines) {
      const match = header.exec(line);
      if (!match) continue;
      const index = batchTargets.findIndex((target) => target === match[1]);
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
  const result = await executeCodeGraphToolRaw(name, args, cwd, signal, options);
  return capLineOrientedToolOutput(
    result,
    CODE_GRAPH_OUTPUT_MAX_BYTES,
    (kept) => _codeGraphBudgetFooter(args, kept),
  );
}

export function isCodeGraphTool(name) {
  return CODE_GRAPH_TOOL_DEFS.some((t) => t.name === name);
}
