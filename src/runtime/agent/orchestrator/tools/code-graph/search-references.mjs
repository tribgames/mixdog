// Reference/caller/impact analysis + formatting, extracted from search.mjs.
// Symbol search / callers / callees / references / impact query layer over a
// built graph. Pure over {graph,cwd,args}; owns no cache state. Extracted
// verbatim from code-graph.mjs.
import { readFileSync } from 'node:fs';
import { _isJsLike } from './lang-predicates.mjs';
import { _maskNonCodeText } from './text-mask.mjs';
import {
  _graphRel,
  _getSourceTextForNode,
  _getSourceLinesForNode,
  _getMaskedLinesForNode,
} from './source-access.mjs';
import {
  _unicodeBoundaryPattern,
  _lookupCandidateNodes,
  _getTokenSymbolsForNode,
  _collectCheapSymbols,
  _capGraphList,
} from './symbol-index.mjs';
import { CODE_GRAPH_MAX_FILES } from './constants.mjs';
import { _inferSpanEndByIndent } from './span.mjs';
import {
  _toByteColumn,
  _byteColToCharCol,
  _nearestEnclosingSymbol,
} from './text-columns.mjs';
import {
  _keywordSymbolSortKey,
  _tokenizeKeyword,
  _keywordMatchesSymbolName,
} from './keyword-match.mjs';

import { _extractCallees, _formatCalleeRow, _cheapReferenceSearch, _formatSymbolHitLocation, _findSymbolHits, _augmentNoHitDiagnostic } from './search.mjs';

export function _parseReferenceEntries(referenceText) {
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

export function _formatSymbolImpactLine(item) {
  const callerSuffix = item.callers.length ? ` -> ${item.callers.join(', ')}` : '';
  return `${item.symbol}\trefs=${item.references}\tcallers=${item.callers.length}${callerSuffix}`;
}

export function _collectImpactSymbols(node, graph) {
  const names = new Set();
  for (const typeName of Array.isArray(node?.topLevelTypes) ? node.topLevelTypes : []) names.add(typeName);
  const text = _getSourceTextForNode(graph, node);
  for (const item of _collectCheapSymbols(text, node.lang)) names.add(item.name);
  return [...names];
}

export function _buildImpactSummary(node, graph, cwd, targetSymbol = '') {
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
    symbolImpact.push({ symbol, references: refs.length, callers });
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

export function _findSymbolAcrossGraph(graph, symbol, cwd, { language = null, limit = 5, fileRel = null, body = true } = {}) {
  const allHits = _findSymbolHits(graph, symbol, { language });
  const hits = fileRel ? allHits.filter((h) => h.rel === fileRel) : allHits;

  if (!hits.length) {
    const nodeCount = graph?.nodes?.size ?? 0;
    const scopeNote = fileRel ? ` file=${fileRel}` : '';
    const lines = [`(no symbol matches in cwd=${cwd}${scopeNote})`];
    lines.push(`graph: nodes=${nodeCount}${language ? `, language=${language}` : ''}`);
    if (graph?.truncated) {
      lines.push(`WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — symbol may exist in an un-indexed file. Re-run with a narrower cwd.`);
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
    return lines.join('\n');
  }

  const topHits = hits.slice(0, Math.max(1, limit));
  const primary = topHits[0];
  const declHits = hits.filter((h) => h.declarationLike);
  const declCount = declHits.length;
  const lines = [];
  if (declCount > 1) {
    lines.push(`⚠ ${declCount} declarations found — verify which one you intend`);
    for (const h of declHits) lines.push(`  ${_formatSymbolHitLocation(h)} [${h.lang}]`);
    lines.push('');
  }
  if (primary?.declarationLike) {
    lines.push(graph?.truncated
      ? '# best declaration candidate (GRAPH TRUNCATED — may not be canonical; re-run with a narrower cwd to confirm)'
      : '# best declaration candidate');
    const multi = declCount > 1 ? `, declarations=${declCount}` : '';
    lines.push(`${_formatSymbolHitLocation(primary)} (${primary.lang}, matches=${primary.matchCount}${multi})`);
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
        end = Math.min(end, start + 299);
        const BODY_FULL_MAX = 120;
        const BODY_HEAD = 90;
        const BODY_TAIL = 20;
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
  if (declCount === 0 && hits.length > 0) {
    lines.push('');
    lines.push(`(no user declaration found; likely a global/builtin identifier — all ${hits.length} hits are references)`);
  }
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
  const _nodeCount = graph?.nodes?.size ?? 0;
  const truncatedSuffix = graph?.truncated
    ? ` [WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — some files not indexed]`
    : '';
  const fileScopeSuffix = fileRel ? ` file=${fileRel}` : '';
  lines.push(`\n# scope: cwd=${cwd} graph=${_nodeCount}-nodes${language ? ` language=${language}` : ''}${fileScopeSuffix}${truncatedSuffix}`);
  return lines.join('\n');
}

export function _resolveReferenceLanguageNode(graph, symbol, rel, cwd, language = null) {
  if (rel) {
    const node = graph.nodes.get(rel);
    if (!node) return { kind: 'file-not-found', node: null, file: rel };
    const tokens = _getTokenSymbolsForNode(graph, node);
    if (Array.isArray(tokens) && tokens.includes(String(symbol || ''))) return { kind: 'ok', node, file: rel };
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

export function _referenceKind(line, symbol, lang = null) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return 'reference';
  const text = String(line || '');
  if (new RegExp(
    `\\b(?:` +
      `function|class|interface|type|enum|record|struct|union` +
      `|namespace|module|package|trait|impl|object` +
      `|const|let|var|val|typedef` +
      `|def|fn|fun` +
    `)\\s+${escaped}\\b`,
  ).test(text)) return 'declaration';
  if (new RegExp(`\\bfunc(?:\\s*\\([^)]*\\))?\\s+${escaped}\\b`).test(text)) return 'declaration';
  if (new RegExp(`\\bimport\\b[\\s\\S]*${_unicodeBoundaryPattern(escaped, lang, symbol)}`, 'u').test(text)) return 'import';
  if (new RegExp(`${_unicodeBoundaryPattern(escaped, lang, symbol)}\\s*\\(`, 'u').test(text)) return 'call';
  return 'reference';
}

export function _collectCallerEntries(graph, symbol, referenceText) {
  const entries = _parseReferenceEntries(referenceText);
  const detailed = [];
  const declLinesCache = new Map();
  for (const entry of entries) {
    const node = graph.nodes.get(entry.file);
    if (!node) continue;
    const sourceText = _getSourceTextForNode(graph, node);
    const sourceLines = sourceText.split(/\r?\n/);
    const line = String(sourceLines[entry.line - 1] || '').trim();
    if (!line) continue;
    let kind = _referenceKind(line, symbol, node.lang);
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

export function _formatCallerReferences(graph, symbol, referenceText, { limit = 200 } = {}) {
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

export function _callerNamesOf(graph, symbol, cwd, language) {
  const refs = _cheapReferenceSearch(graph, symbol, cwd, { language });
  const byName = new Map();
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
  const ANON_LEAF_MAX = 6;
  const leafList = leaves.size <= ANON_LEAF_MAX ? [...leaves.values()] : [];
  return [...byName.values(), ...leafList];
}

export function _formatTransitiveCallers(graph, rootSymbol, cwd, { language = null, depth = 2, pageSize = 100, page = 1, hardMax = 1000 } = {}) {
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
  const hasMore = overflow || (start + slice.length) < total;
  const lines = [
    `# transitive callers of ${rootSymbol} (depth=${depth}) — page ${pg}, nodes ${start + 1}-${start + slice.length} of ${total}${overflow ? '+' : ''}; INDENTED children are ITS callers`,
    rootSymbol,
    ...slice.map((e) => `${'  '.repeat(e.indent)}${e.label}`),
  ];
  if (hasMore) {
    lines.push(`# NEXT — more callers remain; re-run callers with the SAME symbol + depth + page:${pg + 1} for the next ${size} node(s). Every node carries file:line — do NOT grep/read.`);
  } else {
    lines.push(`# END — complete caller set delivered (page ${pg} of ${lastPage}): named callers PLUS timer/event/module-level call sites (the «…» leaves), each with file:line. No further callers/grep/read is needed.`);
  }
  return lines.join('\n');
}

// #4 UNSCOPED empty-result diagnostic. Distinguishes "defined but no edge"
// from "not indexed at all" so the caller doesn't re-scope/grep needlessly.
