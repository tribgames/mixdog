// Tool dispatch layer: codeGraph (mode router), findSymbolTool,
// resolveSymbolReadSpan, executeCodeGraphTool (entry with cwd re-rooting +
// batch fan-out + abort race), isCodeGraphTool. Extracted verbatim from
// code-graph.mjs.
import { resolve as pathResolve, isAbsolute, relative as pathRelative } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { normalizeInputPath, toDisplayPath } from '../builtin.mjs';
import { findFileByBasename } from '../builtin/path-diagnostics.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../code-graph-tool-defs.mjs';
import { CODE_GRAPH_MAX_FILES } from './constants.mjs';
import { _graphRel, _getSourceTextForNode, _appendSameBasenameHint } from './source-access.mjs';
import { _extractSymbolsCheap, _buildExplainerFileSummary } from './symbol-index.mjs';
import { _inferSpanEndByIndent } from './span.mjs';
import {
  _PROJECT_ROOT_SENTINELS,
  _resolveFileProjectRoot,
  _findDirProjectRoot,
  _stripEmptyArgs,
} from './project-root.mjs';
import { buildCodeGraphAsync, prewarmCodeGraph, prewarmCodeGraphSymbols } from './build.mjs';
import {
  _findSymbolHits,
  _findSymbolAcrossGraph,
  _searchSymbolsByKeyword,
  _extractCallees,
  _formatCalleeRow,
  _CALLEES_BRACE_LANGS,
  _formatRelated,
  _formatImpact,
  _resolveReferenceLanguageNode,
  _prewarmReferenceSourceText,
  _cheapReferenceSearch,
  _formatCallerReferences,
  _formatTransitiveCallers,
  _augmentNoHitDiagnostic,
  _pickCalleeDeclHit,
} from './search.mjs';

const CODE_GRAPH_BATCHABLE_MODES = new Set(['symbol', 'find_symbol', 'symbol_search', 'callers', 'callees', 'references']);
const CODE_GRAPH_FILE_BATCHABLE_MODES = new Set(['imports', 'dependents', 'related', 'impact', 'symbols', 'overview']);

function _collectGraphSymbolList(args) {
  const split = (s) => String(s || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  return [...new Set([
    ...(Array.isArray(args?.symbols) ? args.symbols.map((s) => String(s || '').trim()).filter(Boolean) : []),
    ...(typeof args?.symbols === 'string' ? split(args.symbols) : []),
    ...(typeof args?.symbol === 'string' ? split(args.symbol) : []),
  ])];
}

const CODE_GRAPH_FILE_BATCH_CAP = 20;

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
  if (Array.isArray(out.files) && out.files.length === 1 && !out.file) {
    out.file = out.files[0];
    delete out.files;
  }
  return out;
}

function _collectGraphFileList(args) {
  const split = (s) => String(s || '').split(/,+/).map((t) => t.trim()).filter(Boolean);
  const list = [...new Set([
    ...(Array.isArray(args?.files) ? args.files.map((f) => String(f || '').trim()).filter(Boolean) : []),
    ...(typeof args?.files === 'string' ? split(args.files) : []),
    ...(typeof args?.file === 'string' && args.file.trim() ? [args.file.trim()] : []),
  ])];
  if (list.length > CODE_GRAPH_FILE_BATCH_CAP) {
    const capped = list.slice(0, CODE_GRAPH_FILE_BATCH_CAP);
    capped._capped = true;
    return capped;
  }
  return list;
}

async function codeGraph(args, cwd, signal = null, options = {}) {
  let mode = String(args?.mode || '').trim();
  if (!mode) throw new Error('code_graph: "mode" is required');
  if (mode === 'search') mode = 'symbol_search';
  // Name-only "symbols" calls (symbols[]/symbol without a file) are symbol
  // lookups, not a file outline — absorb into symbol_search instead of
  // erroring "file not found in graph: (missing file)".
  if (mode === 'symbols' && !String(args?.file || '').trim()
      && ((Array.isArray(args?.symbols) && args.symbols.length) || String(args?.symbol || '').trim())) {
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
    if (!node) return _appendSameBasenameHint(`Error: code_graph dependents: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
    const GRAPH_LIST_CAP = 200;
    const depsAll = [...(graph.reverse.get(rel) || [])].sort();
    if (!depsAll.length) return '(no dependents)';
    const deps = depsAll.slice(0, GRAPH_LIST_CAP);
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
    if (rel && !node) return _appendSameBasenameHint(`Error: code_graph find_symbol: file not found in graph: ${normFile || '(missing file)'}`, normFile, graph);
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
    if (keywords.length === 1) {
      return _searchSymbolsByKeyword(graph, keywords[0], cwd, { language, limit });
    }
    // Batch: merge results across symbols, dedupe identical result blocks.
    const seen = new Set();
    const sections = [];
    for (const kw of keywords) {
      const result = _searchSymbolsByKeyword(graph, kw, cwd, { language, limit });
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
    await _prewarmReferenceSourceText(graph, symbol, lang);
    const refResult = _cheapReferenceSearch(graph, symbol, cwd, { language: lang, limit: userLimit, fileRel: rel, scopeRelPrefix });
    return narrowedByCaller ? refResult : _augmentNoHitDiagnostic(refResult, '(no references)', graph, cwd, symbol);
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
    await _prewarmReferenceSourceText(graph, symbol, lang);
    const depth = Math.max(1, Math.min(5, Math.floor(Number(args?.depth) || 1)));
    if (depth > 1) {
      return _formatTransitiveCallers(graph, symbol, cwd, { language: lang, depth, page: args?.page });
    }
    const refs = _cheapReferenceSearch(graph, symbol, cwd, { language: lang, limit: userLimit, fileRel: rel, scopeRelPrefix });
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
  const graph = await buildCodeGraphAsync(cwd, signal);
  if (!graph) throw new Error(`find_symbol: cwd '${cwd}' is not an indexed/known project root or contains zero eligible files`);
  if (options?.scopedCacheOutcome && graph.truncated) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  const symbol = String(args?.symbol || '').trim();
  const language = String(args?.language || '').trim() || null;
  const limit = Math.max(1, Math.min(50, Number(args?.limit || 20)));
  const normFile = normalizeInputPath(args?.file);
  const abs = normFile ? (isAbsolute(normFile) ? pathResolve(normFile) : pathResolve(cwd, normFile)) : null;
  const fileRel = abs ? _graphRel(abs, cwd) : null;
  if (fileRel && !graph.nodes.get(fileRel)) {
    return _appendSameBasenameHint(`Error: find_symbol: file not found in graph: ${normFile}`, normFile, graph);
  }
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

/**
 * Resolve a symbol name to a 1-based [startLine, endLine] declaration span for read().
 * Returns `{ offset, limit, startLine, endLine, rel, note? }` or `{ error }`.
 */
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

export async function executeCodeGraphTool(name, args, cwd, signal = null, options = {}) {
  if (!cwd) throw new Error('find_symbol/code_graph requires cwd — caller did not provide a working directory');
  args = _normalizeGraphFileArgs(args);
  const fileArg = (args && typeof args.file === 'string' && args.file.trim()) ? args.file.trim() : '';
  const baseCwd = (args && typeof args.cwd === 'string' && args.cwd.trim()) ? args.cwd.trim() : cwd;
  let effectiveCwd = baseCwd;
  if (fileArg) {
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
    const projectRoot = _findDirProjectRoot(effectiveCwd);
    if (!projectRoot) {
      throw new Error(
        `${name}: cwd '${effectiveCwd}' is not inside a project (no `
        + `${_PROJECT_ROOT_SENTINELS.join('/')} at it or any ancestor). Refusing to `
        + `index an arbitrary tree. Run 'cwd set <repo>', or pass an explicit `
        + `'cwd' (repo root) or a 'file' anchor.`);
    }
    effectiveCwd = projectRoot;
  }
  if (signal?.aborted) throw new Error('aborted');
  const _work = (() => {
    switch (name) {
      case 'code_graph': {
        const rawMode = String(args?.mode || '').trim();
        const batchMode = rawMode === 'search' ? 'symbol_search' : rawMode;
        const declModes = new Set(['symbol', 'find_symbol']);
        const dispatchOne = (a) => (declModes.has(rawMode)
          ? findSymbolTool(_stripEmptyArgs(a), effectiveCwd, signal, options)
          : codeGraph(a, effectiveCwd, signal, options));
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
        if (CODE_GRAPH_FILE_BATCHABLE_MODES.has(batchMode)) {
          const fileList = _collectGraphFileList(args);
          if (fileList.length > 1) {
            const capped = fileList._capped;
            return (async () => {
              const sections = [];
              for (const f of fileList) {
                let body;
                try { body = await dispatchOne({ ...args, file: f, files: undefined }); }
                catch (e) { body = `Error: ${e?.message || String(e)}`; }
                sections.push(`# ${batchMode} ${f}\n${body}`);
              }
              if (capped) sections.push(`Note: file list capped at ${CODE_GRAPH_FILE_BATCH_CAP} entries.`);
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

export function isCodeGraphTool(name) {
  return CODE_GRAPH_TOOL_DEFS.some((t) => t.name === name);
}
