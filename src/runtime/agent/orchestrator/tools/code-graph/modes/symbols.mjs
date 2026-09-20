/**
 * code-graph/modes/symbols.mjs — the symbol modes: a file's outline
 * (`symbols`), one declaration across the graph (`find_symbol`) and keyword
 * search (`symbol_search`), plus the scoped-import declaration recovery
 * find_symbol uses.
 */
import { dirname as pathDirname } from 'node:path';
import { statSync } from 'node:fs';
import { _graphRel } from '../source-access.mjs';
import { _capGraphList, _symbolOutlineRows } from '../symbol-index.mjs';
import {
  _findSymbolHits,
  _findSymbolAcrossGraph,
  _searchSymbolsByKeyword,
  _declarationOutsideScope,
  _isVendorPath,
  _prewarmSourceTextNodes,
} from '../search.mjs';
import { _buildExactFileGraph } from '../exact-file-graph.mjs';
import {
  collectGraphSymbolList,
  fileNotFound,
  languageArg,
  outlineLanguageForPath,
  requiredSymbol,
} from './shared.mjs';

// The file outline: native record rows, every containment level, ordered by
// line. Filter BEFORE capping: the outline of a symbol-dense file exceeds the
// 200-entry cap, so filtering a pre-capped outline silently lost every
// late-file symbol AND the truncation marker itself — a requested symbol
// past the cap looked like "(no symbols matching …)" with no hint.
export function filterSymbolOutline(node, args) {
  const keywords = collectGraphSymbolList(args);
  const items = _symbolOutlineRows(node);
  if (!items.length) return '(no symbols)';
  if (!keywords.length) return _capGraphList(items).join('\n');
  const needles = keywords.map((keyword) => keyword.toLowerCase());
  const lines = items.filter((line) => needles.some((needle) => line.toLowerCase().includes(needle)));
  return lines.length
    ? _capGraphList(lines).join('\n')
    : `(no symbols matching ${keywords.map((keyword) => JSON.stringify(keyword)).join(', ')})`;
}

// A scoped find_symbol whose only hits are imports points AT a declaration the
// scope excludes. `_declarationOutsideScope` answers from the graph; when the
// graph is a single scoped file it can only resolve the import specifier to a
// path, so the target file is indexed on its own (one binary run, cached by
// source hash) to recover the line and the record facts.
export async function resolveOutsideDeclaration(
  graph,
  symbol,
  { language = null, fileRel = null, scopeRelPrefix = null, signal = null } = {}
) {
  const outside = _declarationOutsideScope(graph, symbol, { language, fileRel, scopeRelPrefix });
  if (!outside?.viaImport || !outside.abs) return outside;
  if (!outlineLanguageForPath(outside.abs)) return outside;
  // A dependency tree stays un-indexed: the path names the file to open, and
  // reading a record out of node_modules would index a tree nobody asked for.
  if (_isVendorPath(outside.abs)) return outside;
  let isFile = false;
  try {
    isFile = statSync(outside.abs).isFile();
  } catch {
    isFile = false;
  }
  // An import that points at a path this process cannot index still names the
  // file the caller must open; the note says it was resolved from the
  // specifier rather than read out of a record.
  if (!isFile) return outside;
  const targetGraph = await _buildExactFileGraph(pathDirname(outside.abs), outside.abs, signal);
  const targetNode = targetGraph?.nodes?.get(_graphRel(outside.abs, pathDirname(outside.abs)));
  const declared = (Array.isArray(targetNode?.symbols) ? targetNode.symbols : []).find((item) => item?.name === symbol);
  if (!declared) return outside;
  return {
    rel: outside.rel,
    line: Number(declared.startLine ?? declared.line) || 0,
    lang: targetNode.lang || '',
    facts: `${declared.exported === true ? 'export ' : ''}${String(declared.kind || '') || 'symbol'}`,
  };
}

// The declaring file's source is read ahead so a `body:true` answer renders
// from the cache instead of a sync read per row.
export async function prewarmPrimaryDeclaration(graph, symbol, language, signal) {
  const hits = _findSymbolHits(graph, symbol, { language });
  const primary = hits.find((hit) => hit.declarationLike) || hits[0];
  await _prewarmSourceTextNodes(graph, [primary?.rel ? graph.nodes.get(primary.rel) : null].filter(Boolean), {
    signal,
  });
}

export async function symbols(ctx) {
  const { args, node } = ctx;
  if (!node) return fileNotFound('symbols', ctx);
  // Record-only: no source read, so an outline costs nothing beyond the graph.
  return filterSymbolOutline(node, args);
}

export async function findSymbol(ctx) {
  const { args, cwd, signal, graph, rel, node, scopeRelPrefix } = ctx;
  const symbol = requiredSymbol('find_symbol', args);
  const language = languageArg(args);
  const limit = Math.max(1, Math.min(50, Number(args?.limit || 20)));
  if (rel && !node) return fileNotFound('find_symbol', ctx);
  if (args?.body !== false) await prewarmPrimaryDeclaration(graph, symbol, language, signal);
  return _findSymbolAcrossGraph(graph, symbol, cwd, {
    language,
    limit,
    fileRel: rel,
    body: args?.body !== false,
    outsideDeclaration: await resolveOutsideDeclaration(graph, symbol, {
      language,
      fileRel: rel,
      scopeRelPrefix,
      signal,
    }),
  });
}

export async function symbolSearch(ctx) {
  const { args, cwd, graph, rel, node, scopeRelPrefix } = ctx;
  const language = languageArg(args);
  const limit = Math.max(1, Math.min(100, Number(args?.limit || 30)));
  const symbolsList = Array.isArray(args?.symbols)
    ? args.symbols.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const keyword = String(args?.symbol || '').trim();
  let keywords = symbolsList;
  if (!keywords.length) keywords = keyword ? [keyword] : [];
  if (!keywords.length) throw new Error('code_graph symbol_search: "symbol" (or "symbols[]") is required.');
  // Native graph symbols answer without source text at all: nodes without
  // them have no keyword matches to contribute, so nothing is read here.
  // Honour the file/directory anchor: symbol_search used to scan the whole
  // graph even when the caller scoped the call.
  if (rel && !node) return fileNotFound('symbol_search', ctx);
  const search = (kw) => _searchSymbolsByKeyword(graph, kw, cwd, { language, limit, fileRel: rel, scopeRelPrefix });
  if (keywords.length === 1) return search(keywords[0]);
  // Batch: merge results across symbols, dedupe identical result blocks.
  const seen = new Set();
  const sections = [];
  for (const kw of keywords) {
    const result = search(kw);
    if (seen.has(result)) continue;
    seen.add(result);
    sections.push(`# symbol_search: ${kw}\n${result}`);
  }
  return sections.join('\n\n');
}
