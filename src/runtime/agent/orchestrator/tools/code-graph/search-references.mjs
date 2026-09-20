// Reference/caller/impact analysis + formatting.
// Symbol search / callers / callees / references / impact query layer over a
// built graph. Pure over {graph,cwd,args}; owns no cache state. Extracted
// verbatim from code-graph.mjs.
import { relative } from 'node:path';
import { _graphRel, _getSourceTextForNode, _getSourceLinesForNode } from './source-access.mjs';
import { _astCallerCallSites, _astFileCallSites, _astCallDisplayCol, _astRelInScope } from './ast-calls.mjs';
import {
  _unicodeBoundaryPattern,
  _lookupCandidateNodes,
  _getTokenSymbolsForNode,
  _capGraphList,
} from './symbol-index.mjs';
import { CODE_GRAPH_MAX_FILES } from './constants.mjs';
import { _inferSpanEndByIndent } from './span.mjs';
import { _toByteColumn, _symbolPathForPosition, _symbolPathForSymbol } from './text-columns.mjs';

import {
  _cheapReferenceSearch,
  _formatSymbolHitLocation,
  _formatSymbolFacts,
  _formatOutsideDeclaration,
  _isTypeDeclarationRel,
  _isTypeFaceOf,
  _findSymbolHits,
  _augmentNoHitDiagnostic,
} from './search.mjs';

export function _formatFullSymbolBody(srcText, startLine, endLine) {
  const all = String(srcText || '').split('\n');
  const start = Math.max(1, Number(startLine) || 1);
  const end = Math.min(all.length, Math.max(start, Number(endLine) || start));
  return all
    .slice(start - 1, end)
    .map((line, index) => `${start + index}: ${line}`)
    .join('\n');
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
    out.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), text: m[4] ? m[4].trim() : '' });
  }
  return out;
}

function _formatSymbolImpactLine(item) {
  const callerSuffix = item.callers.length ? ` -> ${item.callers.join(', ')}` : '';
  return `${item.symbol}\trefs=${item.references}\tcallers=${item.callers.length}${callerSuffix}`;
}

// The symbols `impact` measures: the file's declared names, from the native
// record (plus the adapter's topLevelTypes). No text pass — a file the
// extractor produced nothing for declares nothing to measure.
function _collectImpactSymbols(node) {
  const names = new Set();
  for (const typeName of Array.isArray(node?.topLevelTypes) ? node.topLevelTypes : []) names.add(typeName);
  for (const item of Array.isArray(node?.symbols) ? node.symbols : []) {
    if (item?.name) names.add(item.name);
  }
  return [...names];
}

export function _impactSourceNodes(node, graph, targetSymbol = '') {
  const symbols = targetSymbol ? [targetSymbol] : _collectImpactSymbols(node).slice(0, 8);
  const out = [];
  const seen = new Set();
  for (const candidate of [
    node,
    ...symbols.flatMap((symbol) => _lookupCandidateNodes(graph, symbol, node?.lang || null)),
  ]) {
    if (!candidate?.rel || seen.has(candidate.rel)) continue;
    seen.add(candidate.rel);
    out.push(candidate);
  }
  return out;
}

function _buildImpactSummary(node, graph, cwd, targetSymbol = '') {
  const imports = node.resolvedImports.map((p) => _graphRel(p, cwd));
  const dependents = [...(graph.reverse.get(node.rel) || [])].sort();
  const related = [...new Set([...imports, ...dependents])].sort();
  const symbols = targetSymbol ? [targetSymbol] : _collectImpactSymbols(node).slice(0, 8);
  const symbolImpact = [];
  const externalCallers = new Set();
  let externalReferences = 0;
  for (const symbol of symbols) {
    const refs = _parseReferenceEntries(_cheapReferenceSearch(graph, symbol, cwd, { language: node.lang })).filter(
      (entry) => entry.file !== node.rel
    );
    if (refs.length === 0) continue;
    const callers = [...new Set(refs.map((entry) => entry.file))].sort();
    for (const caller of callers) externalCallers.add(caller);
    externalReferences += refs.length;
    symbolImpact.push({ symbol, references: refs.length, callers });
  }
  symbolImpact.sort((a, b) => b.references - a.references || a.symbol.localeCompare(b.symbol));
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

export function _formatRelated(node, graph, cwd) {
  const imports = node.resolvedImports.map((p) => _graphRel(p, cwd));
  const dependents = [...(graph.reverse.get(node.rel) || [])].sort();
  const related = [...new Set([...imports, ...dependents])].sort();
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

export function _formatImpact(node, graph, cwd, targetSymbol = '') {
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

export function _findSymbolAcrossGraph(
  graph,
  symbol,
  cwd,
  { language = null, limit = 5, fileRel = null, body = true, outsideDeclaration = null, defaultCwd = cwd } = {}
) {
  const allHits = _findSymbolHits(graph, symbol, { language });
  const hits = fileRel ? allHits.filter((h) => h.rel === fileRel) : allHits;
  const outsideLine = outsideDeclaration
    ? `declared outside the requested files: ${_formatOutsideDeclaration(outsideDeclaration)}`
    : '';

  if (!hits.length) {
    const nodeCount = graph?.nodes?.size ?? 0;
    const scopeNote = fileRel ? ` file=${fileRel}` : '';
    const lines = [`(no symbol matches in cwd=${cwd}${scopeNote})`];
    lines.push(`graph: nodes=${nodeCount}${language ? `, language=${language}` : ''}`);
    if (graph?.truncated) {
      lines.push(
        `WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — symbol may exist in an un-indexed file. Re-run with a narrower cwd.`
      );
    }
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
    if (outsideLine) lines.push(outsideLine);
    return lines.join('\n');
  }

  const topHits = hits.slice(0, Math.max(1, limit));
  const primary = topHits[0];
  const declHits = hits.filter((h) => h.declarationLike);
  // A `.d.ts`/`.d.mts`/`.d.cts` companion of an implementation is not a second
  // candidate to choose between — it is the type face of the same symbol. It
  // never wins the "best declaration" slot (see _sortSymbolHits), it is
  // reported separately below, and it does not raise the ambiguity warning: a
  // model told "2 declarations — verify which one you intend" goes and reads
  // both, for a symbol that has exactly one implementation.
  //
  // "Type face" is a relationship between two files of ONE module, not a file
  // extension: a same-named `.d.ts` in another package is a rival declaration,
  // and filing it under the primary would hide a genuine second declaration
  // behind an association that does not exist.
  const implDeclHits = declHits.filter((h) => !_isTypeDeclarationRel(h.rel));
  const typeDeclHits = declHits.filter(
    (h) => _isTypeDeclarationRel(h.rel) && implDeclHits.some((impl) => _isTypeFaceOf(impl.rel, h.rel))
  );
  const rivalDecls = declHits.filter((h) => !typeDeclHits.includes(h));
  const declCount = rivalDecls.length;
  const typeFaces = typeDeclHits;
  const lines = [];
  if (declCount > 1) {
    lines.push(`⚠ ${declCount} declarations found — verify which one you intend`);
    for (const h of rivalDecls.slice(0, Math.max(1, limit))) {
      lines.push(`  ${_formatSymbolHitLocation(h)} [${h.lang}]`);
    }
    if (declCount > limit) {
      lines.push(`  ... ${declCount - limit} more declarations; narrow file or raise limit`);
    }
    lines.push('');
  }
  if (primary?.declarationLike) {
    lines.push(
      graph?.truncated
        ? '# best declaration candidate (GRAPH TRUNCATED — may not be canonical; re-run with a narrower cwd to confirm)'
        : '# best declaration candidate'
    );
    const multi = declCount > 1 ? `, declarations=${declCount}` : '';
    const namePath = primary.namePath ? `, path=${primary.namePath}` : '';
    // Record facts first: the unified kind and the export marker describe WHAT
    // was found before the position describes where.
    const facts = _formatSymbolFacts(primary);
    lines.push(
      `${_formatSymbolHitLocation(primary)} (${primary.lang}${facts ? `, ${facts}` : ''}, matches=${primary.matchCount}${multi}${namePath})`
    );
    if (primary.symbolSig) lines.push(`signature: ${primary.symbolSig}`);
    let bodyEmitted = false;
    if (body === true && Number.isFinite(Number(primary.line))) {
      const node = graph.nodes.get(primary.rel);
      const srcText = node ? _getSourceTextForNode(graph, node) : null;
      if (srcText) {
        const all = srcText.split('\n');
        const start = Math.max(1, Number(primary.line));
        let end = Number(primary.endLine);
        if (!Number.isFinite(end) || end < start) {
          end = _inferSpanEndByIndent(all, start) ?? start;
        }
        lines.push(_formatFullSymbolBody(srcText, start, end));
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
      const others = rivalDecls.slice(1, 3).map((h) => `${_formatSymbolHitLocation(h)} [${h.lang}]`);
      if (others.length) lines.push(`other declarations: ${others.join(', ')}`);
    }
    if (typeFaces.length) {
      const faces = typeFaces.slice(0, 3).map((h) => `${_formatSymbolHitLocation(h)} [${h.lang}]`);
      lines.push(`type declaration: ${faces.join(', ')}`);
    }
    if (hits.length > 1) lines.push('');
  }
  if (hits.length > 1) lines.push('# candidates');
  lines.push(
    ...(hits.length > 1 || !primary?.declarationLike ? topHits : []).map((hit, idx) => {
      const kind = hit.declarationLike ? 'decl' : 'ref';
      const facts = _formatSymbolFacts(hit);
      const suffix = hit.content ? ` — ${hit.content.slice(0, 100)}` : '';
      const namePath = hit.namePath ? ` path=${hit.namePath}` : '';
      const number = hits.length > 1 ? `${idx + 1}. ` : '';
      return `${number}${_formatSymbolHitLocation(hit)} [${kind}${facts ? `, ${facts}` : ''}, ${hit.lang}, matches=${hit.matchCount}]${namePath}${suffix}`;
    })
  );
  if (declCount === 0 && hits.length > 0) {
    lines.push('');
    // "global/builtin" is a verdict about the whole graph, so it may only be
    // said when the graph really knows no declaration and nothing in the scope
    // imports one. Inside a file/files scope the usual truth is the opposite:
    // the hits are the import, and the declaration is one hop away.
    lines.push(
      outsideLine
        ? `${outsideLine}\n(the ${hits.length} hit(s) in the requested scope are imports/references)`
        : `(no user declaration found; likely a global/builtin identifier — all ${hits.length} hits are references)`
    );
  }
  if (graph?.truncated && !primary?.declarationLike) {
    lines.push(`WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — some files not indexed`);
  }
  if (hits.length > 1 && relative(defaultCwd, cwd)) lines.push(`\n# scope: cwd=${cwd}`);
  return lines.join('\n');
}

export function _resolveReferenceLanguageNode(graph, symbol, rel, _cwd, language = null) {
  if (rel) {
    const node = graph.nodes.get(rel);
    if (!node) return { kind: 'file-not-found', node: null, file: rel };
    const tokens = _getTokenSymbolsForNode(node);
    if (tokens?.includes(String(symbol || ''))) return { kind: 'ok', node, file: rel };
    const text = _getSourceTextForNode(graph, node);
    if (typeof text === 'string' && text.includes(String(symbol || ''))) return { kind: 'ok', node, file: rel };
    return { kind: 'symbol-not-present', node: null, file: rel };
  }
  const hits = _findSymbolHits(graph, symbol, { language });
  if (!hits.length) return { kind: 'symbol-not-present', node: null, file: null };
  const primary = hits.find((hit) => hit.declarationLike) || hits[0];
  const node = primary?.rel ? graph.nodes.get(primary.rel) || null : null;
  return node ? { kind: 'ok', node, file: node.rel } : { kind: 'symbol-not-present', node: null, file: null };
}

function _referenceKind(line, symbol, lang = null) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return 'reference';
  const text = String(line || '');
  if (
    new RegExp(
      `\\b(?:` +
        `function|class|interface|type|enum|record|struct|union` +
        `|namespace|module|package|trait|impl|object` +
        `|const|let|var|val|typedef` +
        `|def|fn|fun` +
        `)\\s+${escaped}\\b`
    ).test(text)
  )
    return 'declaration';
  if (new RegExp(`\\bfunc(?:\\s*\\([^)]*\\))?\\s+${escaped}\\b`).test(text)) return 'declaration';
  if (new RegExp(`\\bimport\\b[\\s\\S]*${_unicodeBoundaryPattern(escaped, lang, symbol)}`, 'u').test(text))
    return 'import';
  if (new RegExp(`${_unicodeBoundaryPattern(escaped, lang, symbol)}\\s*\\(`, 'u').test(text)) return 'call';
  return 'reference';
}

// ── AST call sites ──────────────────────────────────────────────────────────
// Call sites come from the native `calls` wire and from nowhere else: there is
// no text fallback. A file without usable call data contributes no call rows.
//
// The wire carries only the INNERMOST enclosing symbol name. When the file's
// outline has spans, the containment chain (`Outer/inner`) the non-call
// reference rows also use is recovered by locating that symbol at the line;
// without spans — or when no symbol of that name covers the line — the
// innermost name is the whole answer.
function _astCallerPath(node, call) {
  const name = call.inSymbol || '';
  if (!name) return '';
  const covering = (Array.isArray(node?.symbols) ? node.symbols : []).filter((item) => {
    if (item?.name !== name) return false;
    const start = Number(item.startLine ?? item.line);
    const end = Number(item.endLine);
    return Number.isFinite(start) && Number.isFinite(end) && start <= call.line && end >= call.line;
  });
  if (!covering.length) return name;
  // Innermost of several same-name spans: the one that starts last.
  const innermost = covering.reduce((best, item) =>
    Number(item.startLine ?? item.line) > Number(best.startLine ?? best.line) ? item : best
  );
  return _symbolPathForSymbol(node, innermost) || name;
}

function _astEntryFromCall(graph, node, call) {
  const sourceLines = _getSourceLinesForNode(graph, node);
  const lineText = String(sourceLines[call.line - 1] || '').trim();
  const callerPath = _astCallerPath(node, call);
  return {
    file: node.rel,
    line: call.line,
    // 0-based AST column → the 1-based column every location line uses.
    col: _astCallDisplayCol(call),
    text: lineText,
    kind: 'call',
    caller: callerPath,
    owner: callerPath,
    lineText,
    callKind: call.kind,
    recv: call.recv || '',
  };
}

// references: AST call sites of `symbol` inside the files the reference scan
// already visited — the scan's scope, language and candidate filters are
// therefore preserved exactly.
function _astReferenceCallEntries(graph, symbol, referenceText) {
  const rels = [...new Set(_parseReferenceEntries(referenceText).map((entry) => entry.file))];
  const out = [];
  for (const rel of rels) {
    const node = graph?.nodes?.get(rel);
    if (!node) continue;
    const calls = _astFileCallSites(node, symbol);
    if (!calls) continue; // calls === null → no call rows for this file
    for (const call of calls) out.push(_astEntryFromCall(graph, node, call));
  }
  return out;
}

// callers: AST call sites reaching a declaring file, already grouped by
// (file, inSymbol) by _astCallerCallSites.
function _astCallerEntries(graph, symbol, targetRels, scope) {
  if (!targetRels?.length) return [];
  return _astCallerCallSites(graph, symbol, targetRels, scope).map(({ node, call }) =>
    _astEntryFromCall(graph, node, call)
  );
}

// references only: the identifier USAGES that are not call sites — a type
// position, an assignment, a bare mention. Declarations, imports and anything
// call-shaped are dropped here; call rows come exclusively from `calls`, so a
// regex "call" hit is never turned into a row (its file either reports the
// call from the AST or does not report it at all).
function _textReferenceEntries(graph, symbol, referenceText) {
  const detailed = [];
  for (const entry of _parseReferenceEntries(referenceText)) {
    const node = graph.nodes.get(entry.file);
    if (!node) continue;
    const sourceText = _getSourceTextForNode(graph, node);
    const sourceLines = sourceText.split(/\r?\n/);
    const line = String(sourceLines[entry.line - 1] || '').trim();
    if (!line) continue;
    if (_referenceKind(line, symbol, node.lang) !== 'reference') continue;
    const _encByteCol = _toByteColumn(sourceLines[entry.line - 1] || '', entry.col);
    const owner = _symbolPathForPosition(node, sourceText, entry.line, _encByteCol);
    detailed.push({
      ...entry,
      kind: 'reference',
      caller: '',
      owner,
      lineText: line,
    });
  }
  return detailed;
}

function _sortEntries(entries, { groupByCaller = false } = {}) {
  return entries.sort(
    (a, b) =>
      String(a.file).localeCompare(String(b.file)) ||
      (groupByCaller ? String(a.caller || '').localeCompare(String(b.caller || '')) : 0) ||
      a.line - b.line ||
      a.col - b.col
  );
}

export function _formatReferenceDetails(graph, symbol, referenceText, { limit = 200 } = {}) {
  // Two disjoint sources: call sites from the AST, non-call identifier usages
  // from the text scan. A file the binary did not extract contributes only the
  // latter.
  const astEntries = _astReferenceCallEntries(graph, symbol, referenceText);
  const astPositions = new Set(astEntries.map((entry) => `${entry.file}\u0000${entry.line}\u0000${entry.col}`));
  const textEntries = _textReferenceEntries(graph, symbol, referenceText).filter(
    (entry) => !astPositions.has(`${entry.file}\u0000${entry.line}\u0000${entry.col}`)
  );
  const detailed = _sortEntries([...textEntries, ...astEntries]);
  if (!detailed.length) return '(no references)';
  const shown = detailed.slice(0, limit);
  const rows = shown.map((entry) => {
    const owner = entry.owner ? `\towner=${entry.owner}` : '';
    return `${entry.file}:${entry.line}:${entry.col}\t${entry.kind}${owner}\t${entry.lineText.slice(0, 80)}`;
  });
  if (detailed.length > shown.length) rows.push(`... +${detailed.length - shown.length} more references`);
  return rows.join('\n');
}

// `targetRels` are the files the symbol is DECLARED in — the anchors of the
// caller rule. Every row is an AST call site; no declaration anchor means no
// call sites, never a text guess.
export function _formatCallerReferences(
  graph,
  symbol,
  { limit = 200, targetRels = null, language = null, fileRel = null, scopeRelPrefix = null } = {}
) {
  const callSites = _sortEntries(_astCallerEntries(graph, symbol, targetRels, { language, fileRel, scopeRelPrefix }), {
    groupByCaller: true,
  });
  if (!callSites.length) return '(no callers)';
  const format = (entry) => {
    const caller = entry.caller ? `\tcaller=${entry.caller}` : '';
    return `${entry.file}:${entry.line}:${entry.col}\t${entry.kind}${caller}\t${entry.lineText.slice(0, 80)}`;
  };
  const total = callSites.length;
  const head = callSites.slice(0, limit).map(format);
  const overflow = total > limit ? [`... +${total - limit} more call sites`] : [];
  return ['# call sites', ...head, ...overflow].join('\n');
}

// Every file a symbol is DECLARED in — the anchors of the caller rule.
// Empty when no declaration is indexed for the symbol, which then has no
// call sites to report.
//
// ALL declaring files are returned, not just the best one: `executeCodeGraphTool`
// in this repo has four declaration-like hits (the tool module, the daemon, two
// test doubles) and anchoring on the top-ranked one reported none of its 31 real
// call sites. A call site counts when it reaches ANY declaration of that name.
//
// A `file`/directory anchor scopes the SCAN, and it also narrows the anchors:
// with several same-name declarations the scoped one wins, so a file-scoped
// query answers about the declaration the caller pointed at.
const _AST_TARGET_RELS_MAX = 16;

export function _astCallerTargetRels(graph, symbol, language = null, { fileRel = null, scopeRelPrefix = null } = {}) {
  const hits = _findSymbolHits(graph, symbol, { language });
  if (!hits.length) return [];
  const scoped =
    fileRel || scopeRelPrefix ? hits.filter((hit) => _astRelInScope(hit.rel, fileRel, scopeRelPrefix)) : [];
  const pool = scoped.length ? scoped : hits;
  const declaring = pool.filter((hit) => hit.declarationLike);
  // No declaration-like hit at all → the top-ranked hit is the best anchor
  // available (hits are already relevance-sorted).
  const chosen = declaring.length ? declaring : pool.slice(0, 1);
  return [...new Set(chosen.map((hit) => hit.rel).filter(Boolean))].slice(0, _AST_TARGET_RELS_MAX);
}

function _callerNamesOf(graph, symbol, language, { fileRel = null, scopeRelPrefix = null } = {}) {
  const byName = new Map();
  const leaves = new Map();
  // Every level of the transitive walk uses the same rule as depth=1.
  const targetRels = _astCallerTargetRels(graph, symbol, language, { fileRel, scopeRelPrefix });
  const entries = _sortEntries(_astCallerEntries(graph, symbol, targetRels, { language, fileRel, scopeRelPrefix }), {
    groupByCaller: true,
  });
  for (const e of entries) {
    if (e.caller && e.caller !== symbol) {
      if (!byName.has(e.caller)) byName.set(e.caller, { name: e.caller, loc: `${e.file}:${e.line}`, leaf: false });
    } else if (!e.caller) {
      const loc = `${e.file}:${e.line}`;
      if (!leaves.has(loc)) {
        const snippet = String(e.lineText || 'call')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 48);
        leaves.set(loc, { name: `«${snippet}»`, loc, leaf: true });
      }
    }
  }
  const ANON_LEAF_MAX = 6;
  const leafList = leaves.size <= ANON_LEAF_MAX ? [...leaves.values()] : [];
  return [...byName.values(), ...leafList];
}

export function _formatTransitiveCallers(
  graph,
  rootSymbol,
  cwd,
  { language = null, depth = 2, pageSize = 100, page = 1, hardMax = 1000, fileRel = null, scopeRelPrefix = null } = {}
) {
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
    for (const entry of _callerNamesOf(graph, symbol, language, { fileRel, scopeRelPrefix })) {
      if (collected.length >= hardMax) {
        overflow = true;
        return;
      }
      collected.push({ indent: level + 1, label: `${entry.name}\t${entry.loc}` });
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
  const hasMore = overflow || start + slice.length < total;
  const lines = [
    `# transitive callers of ${rootSymbol} (depth=${depth}) — page ${pg}, nodes ${start + 1}-${start + slice.length} of ${total}${overflow ? '+' : ''}; INDENTED children are ITS callers`,
    rootSymbol,
    ...slice.map((e) => `${'  '.repeat(e.indent)}${e.label}`),
  ];
  if (hasMore) {
    lines.push(
      `# NEXT — more callers remain; re-run callers with the SAME symbol + depth + page:${pg + 1} for the next ${size} node(s). Every node carries file:line — do NOT grep/read.`
    );
  } else {
    lines.push(
      `# END — complete caller set delivered (page ${pg} of ${lastPage}): named callers PLUS timer/event/module-level call sites (the «…» leaves), each with file:line. No further callers/grep/read is needed.`
    );
  }
  return lines.join('\n');
}

// #4 UNSCOPED empty-result diagnostic. Distinguishes "defined but no edge"
// from "not indexed at all" so the caller doesn't re-scope/grep needlessly.
