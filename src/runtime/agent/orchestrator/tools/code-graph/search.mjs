// Symbol search / callers / callees / references / impact query layer over a
// built graph. Pure over {graph,cwd,args}; owns no cache state.
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { resolve as pathResolve, dirname as pathDirname, basename as pathBasename } from 'node:path';
import { normalizeOutputPath } from '../builtin/path-utils.mjs';
import { codeGraphSourceIoAdmission } from '../../../../shared/tool-workload-gates.mjs';
import { _getSourceTextForNode, _getSourceLinesForNode, _getMaskedLinesForNode, _graphRel } from './source-access.mjs';
import { _unicodeBoundaryPattern, _lookupCandidateNodes, _symbolLine } from './symbol-index.mjs';
import { CODE_GRAPH_MAX_FILES } from './constants.mjs';
import { _symbolPathForSymbol } from './text-columns.mjs';
import { _keywordSymbolSortKey, _tokenizeKeyword, _keywordMatchesSymbolName } from './keyword-match.mjs';
import { _astCalleeCallSites, _astCallDisplayCol, _astImportedRels } from './ast-calls.mjs';

export {
  _formatRelated,
  _formatImpact,
  _impactSourceNodes,
  _findSymbolAcrossGraph,
  _resolveReferenceLanguageNode,
  _formatReferenceDetails,
  _formatCallerReferences,
  _formatTransitiveCallers,
  _astCallerTargetRels,
} from './search-references.mjs';

// callees — native AST call sites of the declaring file, the only source.
//
// Selection: F.calls whose inSymbol is the queried symbol, plus — when the
// symbol is a container type (class/interface/enum/…) the outline can delimit
// by line span — the calls sitting in its member symbols. Members are matched
// by NAME, since inSymbol is a name; when the outline cannot prove containment
// the match stays exact.
//
// Recursive self-calls are real call sites (the AST separates them from the
// declaration) and builtin names are not blacklisted: a callee the graph
// cannot resolve is simply reported as external. Rows are deduped by
// (kind, recv, name) and carry kind/recv. A file whose `calls` is absent or
// malformed contributes no rows at all.
export function _extractCallees(graph, declHit, _cwd, { cap = 200, callerSymbol = null, language = null } = {}) {
  if (!declHit) return [];
  const declNode = graph.nodes.get(declHit.rel);
  if (!declNode) return [];
  const callSites = _astCalleeCallSites(declNode, callerSymbol || declHit?.name || '') || [];
  if (!callSites.length) return [];
  const seen = new Map();
  for (const call of callSites) {
    const key = `${call.kind}\u0000${call.recv}\u0000${call.name}`;
    if (!seen.has(key)) seen.set(key, call);
  }
  const all = [...seen.values()];
  const sliced = all.slice(0, cap);
  const sourceLines = _getSourceLinesForNode(graph, declNode);
  const importedRels = _astImportedRels(declNode, graph?.cwd || _cwd);
  const declLookupCache = new Map();
  const rows = [];
  for (const call of sliced) {
    let declPath = '';
    let declLine = 0;
    let resolved = false;
    try {
      if (!declLookupCache.has(call.name)) {
        declLookupCache.set(
          call.name,
          _resolveCalleeDeclaration(graph, call.name, { language, preferRel: declNode.rel })
        );
      }
      const calleeDecl = declLookupCache.get(call.name);
      if (calleeDecl?.declarationLike) {
        // A qualified method call only resolves to a declaration this file can
        // actually reach: its own file or a directly imported one.
        const reachable =
          call.kind !== 'method' ||
          !call.recv ||
          calleeDecl.rel === declNode.rel ||
          importedRels.includes(calleeDecl.rel);
        if (reachable) {
          declPath = calleeDecl.rel;
          declLine = calleeDecl.line || 0;
          resolved = true;
        }
      }
    } catch {
      // Identifier shapes that trip the lookup regex fall through as external.
    }
    rows.push({
      name: call.name,
      callsitePath: declNode.rel,
      callsiteLine: call.line,
      callsiteCol: _astCallDisplayCol(call),
      declPath,
      declLine,
      external: !resolved,
      enclosing: call.inSymbol || '',
      snippet: String(sourceLines[call.line - 1] || '')
        .trim()
        .slice(0, 80),
      kind: call.kind,
      recv: call.recv,
    });
  }
  if (all.length > sliced.length) {
    rows.push({
      name: '...',
      callsitePath: '',
      callsiteLine: 0,
      declPath: '',
      declLine: 0,
      enclosing: '',
      snippet: `+${all.length - sliced.length} more callees (cap=${cap})`,
      truncationFooter: true,
    });
  }
  return rows;
}

export function _formatCalleeRow(row) {
  if (row.truncationFooter) return `... ${row.snippet}`;
  const position = Number.isFinite(Number(row.callsiteCol))
    ? `${row.callsiteLine}:${row.callsiteCol}`
    : `${row.callsiteLine}`;
  const callsite = row.callsitePath ? `callsite ${row.callsitePath}:${position}` : 'callsite (unknown)';
  const origin = `\tkind=${row.kind}${row.recv ? ` recv=${row.recv}` : ''}`;
  if (row.external) {
    const enclosingExt = row.enclosing ? `(in ${row.enclosing})` : '(in ?)';
    return `${row.name}\t${callsite}\tdecl (external/builtin)\t${enclosingExt}${origin}`;
  }
  const decl = row.declPath ? `decl ${row.declPath}:${row.declLine}` : 'decl (unresolved)';
  const enclosing = row.enclosing ? `(in ${row.enclosing})` : '(in ?)';
  return `${row.name}\t${callsite}\t${decl}\t${enclosing}${origin}`;
}
const CODE_GRAPH_SOURCE_READ_CONCURRENCY = Math.max(
  1,
  Math.min(32, Math.floor(Number(process.env.MIXDOG_CODE_GRAPH_SOURCE_READ_CONCURRENCY) || 8))
);

export async function _prewarmSourceTextNodes(
  graph,
  nodes,
  { concurrency = CODE_GRAPH_SOURCE_READ_CONCURRENCY, readFileImpl = readFile, signal = null, ownerKey = null } = {}
) {
  const sourceNodes = [];
  const seen = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node?.rel || !node?.abs || seen.has(node.rel)) continue;
    seen.add(node.rel);
    sourceNodes.push(node);
  }
  const uncached = [];
  for (const node of sourceNodes) {
    const cached = graph._sourceTextCache?.get(node.rel);
    if (!cached || cached.fingerprint !== (node.fingerprint || '')) {
      uncached.push(node);
    }
  }
  let next = 0;
  const worker = async () => {
    while (!signal?.aborted) {
      const index = next++;
      if (index >= uncached.length) return;
      const node = uncached[index];
      try {
        const text = await codeGraphSourceIoAdmission.run(ownerKey, () => readFileImpl(node.abs, 'utf8'), { signal });
        graph._sourceTextCache?.set(node.rel, { fingerprint: node.fingerprint || '', text });
      } catch {
        /* skip unreadable/aborted file */
      }
    }
  };
  const workerCount = Math.min(
    Math.max(1, Math.floor(Number(concurrency) || CODE_GRAPH_SOURCE_READ_CONCURRENCY)),
    Math.max(1, uncached.length)
  );
  if (uncached.length > 0) {
    await Promise.all(Array.from({ length: workerCount }, worker));
  }
  return sourceNodes;
}

export async function _prewarmReferenceSourceText(graph, symbol, language, options = {}) {
  const candidateNodes = _lookupCandidateNodes(graph, symbol, language);
  // Return the resolved candidate set so the immediately-following
  // _cheapReferenceSearch (references/callers dispatch) can reuse it instead
  // of recomputing _lookupCandidateNodes for the same (symbol, language) —
  // which on a token-index miss is a full-graph scan run twice per symbol.
  await _prewarmSourceTextNodes(graph, candidateNodes, options);
  return candidateNodes;
}

export function _cheapReferenceSearch(
  graph,
  symbol,
  _cwd,
  { language = null, fileRel = null, scopeRelPrefix = null, nodes = null } = {}
) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return '(no references)';
  // No `limit` in the key: the raw hit set is limit-independent (see below),
  // so every limit shares one cached scan.
  const cacheKey = `${language || '*'}|${symbol}|${fileRel || '*'}|${scopeRelPrefix || '*'}`;
  const cached = graph?._referenceSearchCache?.get(cacheKey);
  if (typeof cached === 'string') {
    return cached;
  }
  const lines = [];
  // Reuse the caller's precomputed candidate set (from
  // _prewarmReferenceSourceText) when provided — same (symbol, language) so
  // the node set is identical; the fileRel/scopeRelPrefix filters below still
  // apply, keeping the result byte-for-byte unchanged.
  let candidateNodes = Array.isArray(nodes) ? nodes : _lookupCandidateNodes(graph, symbol, language);
  if (fileRel) candidateNodes = candidateNodes.filter((node) => node.rel === fileRel);
  if (scopeRelPrefix)
    candidateNodes = candidateNodes.filter(
      (node) => node.rel === scopeRelPrefix.slice(0, -1) || node.rel.startsWith(scopeRelPrefix)
    );
  // The caller's `limit` bounds the FORMATTED rows, and the formatters
  // (_formatReferenceDetails / _formatCallerReferences) drop declarations,
  // imports and non-call lines AFTER this scan. Truncating the raw scan to the
  // same limit therefore threw away the real references — a small limit whose
  // first hits were the declaration and its imports reported
  // "(no references)" / "(no callers)". Collect up to the scan budget and let
  // the formatters apply the user limit post-filter.
  const REFERENCE_HIT_CAP = Math.max(1, Number(process.env.REFERENCE_HIT_CAP) || 200);
  const REFERENCE_LINE_CAP = Math.max(20, Number(process.env.REFERENCE_LINE_CAP) || 80);
  let cappedOut = false;
  outer: for (const node of candidateNodes) {
    const sourceText = _getSourceTextForNode(graph, node);
    if (!sourceText.includes(symbol)) continue;
    const fileLines = _getMaskedLinesForNode(graph, node);
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
          cappedOut = true;
          break outer;
        }
      }
    }
  }
  const result = lines.length ? lines.join('\n') : '(no references)';
  const finalResult = cappedOut
    ? `${result}\n\n[truncated — total hits exceeded ${REFERENCE_HIT_CAP}, showing first ${REFERENCE_HIT_CAP}; raise REFERENCE_HIT_CAP env var for more]`
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

export function _formatSymbolHitLocation(hit) {
  const line = Number(hit.line);
  const col = Number(hit.col) || 1;
  const end = Number(hit.endLine);
  if (Number.isFinite(end) && end >= line) return `${hit.rel}:${line}-${end}:${col}`;
  return `${hit.rel}:${line}:${col}`;
}

// A `.d.ts` / `.d.mts` / `.d.cts` file declares a TYPE for an implementation
// that lives elsewhere: it is a real declaration, but never the one a caller
// asking "where is this defined" wants to read first. It ranks below any
// non-declaration file that declares the same name.
const _TYPE_DECLARATION_RE = /\.d\.(?:ts|mts|cts)$/i;

export function _isTypeDeclarationRel(rel) {
  return _TYPE_DECLARATION_RE.test(String(rel || ''));
}

// …of THAT implementation. A `.d.ts` is the type face of the module it sits
// next to (`error-code.d.mts` ↔ `error-code.mjs`), and of nothing else: a
// same-named declaration in another package/directory is a RIVAL declaration,
// so it keeps its place in the ambiguity count instead of being filed under
// the primary as its type face — which would both hide a real second
// declaration and assert a module relationship that does not exist.
const _IMPL_EXTENSION_RE = /\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx)$/i;

function _moduleStem(rel) {
  const base =
    String(rel || '')
      .replace(/\\/g, '/')
      .split('/')
      .pop() || '';
  const stem = _isTypeDeclarationRel(base)
    ? base.replace(_TYPE_DECLARATION_RE, '')
    : base.replace(_IMPL_EXTENSION_RE, '');
  return stem.toLowerCase();
}

function _dirOf(rel) {
  const path = String(rel || '').replace(/\\/g, '/');
  const cut = path.lastIndexOf('/');
  return (cut < 0 ? '' : path.slice(0, cut)).toLowerCase();
}

export function _isTypeFaceOf(implRel, typeRel) {
  if (!implRel || !typeRel) return false;
  return _dirOf(implRel) === _dirOf(typeRel) && _moduleStem(implRel) === _moduleStem(typeRel);
}

function _sortSymbolHits(hits) {
  if (!hits?.length) return hits;
  const depthOf = (rel) => String(rel || '').split('/').length;
  const isCanonicalSrc = (rel) => /^src\//.test(rel || '');
  hits.sort(
    (a, b) =>
      Number(b.declarationLike) - Number(a.declarationLike) ||
      Number(_isTypeDeclarationRel(a.rel)) - Number(_isTypeDeclarationRel(b.rel)) ||
      Number(isCanonicalSrc(b.rel)) - Number(isCanonicalSrc(a.rel)) ||
      depthOf(a.rel) - depthOf(b.rel) ||
      b.matchCount - a.matchCount ||
      a.rel.localeCompare(b.rel) ||
      a.line - b.line
  );
  const declCount = hits.reduce((n, h) => n + (h.declarationLike ? 1 : 0), 0);
  if (declCount > 1 && hits[0]) hits[0].ambiguousDeclaration = declCount;
  return hits;
}

export function _findSymbolHits(graph, symbol, { language = null } = {}) {
  const cleanSymbol = String(symbol || '').trim();
  if (!cleanSymbol) return [];
  const namePath = cleanSymbol.replace(/^\/+|\/+$/g, '');
  const leaf = namePath.split('/').at(-1) || '';
  const candidateNodes = _lookupCandidateNodes(graph, leaf, language);
  if (cleanSymbol.includes('/')) {
    const absolute = cleanSymbol.startsWith('/');
    const hits = [];
    for (const node of candidateNodes) {
      const sourceLines = _getSourceLinesForNode(graph, node);
      for (const nativeSymbol of Array.isArray(node.symbols) ? node.symbols : []) {
        if (nativeSymbol?.name !== leaf) continue;
        const nativePath = _symbolPathForSymbol(node, nativeSymbol);
        if (nativePath !== namePath && (absolute || !nativePath.endsWith(`/${namePath}`))) continue;
        const line = Number(nativeSymbol.startLine ?? nativeSymbol.line);
        const endLine = Number(nativeSymbol.endLine);
        hits.push({
          rel: node.rel,
          lang: node.lang,
          line,
          col: Number(nativeSymbol.startCol) || 1,
          ...(Number.isFinite(endLine) && endLine >= line ? { endLine } : {}),
          declarationLike: true,
          matchCount: 1,
          namePath: nativePath,
          content: String(sourceLines[line - 1] || '').trim(),
          context: sourceLines
            .slice(line - 1, line + 2)
            .map((item) => String(item || '').trim())
            .filter(Boolean),
          ..._symbolFacts(nativeSymbol),
        });
      }
    }
    return _sortSymbolHits(hits);
  }
  return _findSymbolHitsOnNodes(graph, cleanSymbol, candidateNodes, { language });
}

// Declarations come from the native record ONLY. The regex declaration
// matchers that used to run for files without symbols are gone: they marked
// `declarationLike` on lines the extractor never called a declaration, so the
// hit ranking (and, through it, the caller/callee anchors) depended on which
// path produced the hit. A file with no symbols still yields reference hits —
// it just declares nothing.
function _findSymbolHitsOnNodes(graph, cleanSymbol, candidateNodes, { language = null } = {}) {
  if (!cleanSymbol) return [];
  const escaped = cleanSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = [];
  for (const node of candidateNodes) {
    const nativeSymbols = (Array.isArray(node.symbols) ? node.symbols : []).filter(
      (symbol) => symbol?.name === cleanSymbol
    );
    const sourceText = _getSourceTextForNode(graph, node);
    if (!sourceText.includes(cleanSymbol)) {
      for (const nativeSymbol of nativeSymbols) {
        const hit = _nativeSymbolHit(node, nativeSymbol);
        if (hit) hits.push(hit);
      }
      continue;
    }
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
    const nativeDeclSymbols = new Map();
    for (const nativeSymbol of nativeSymbols) {
      const line = _symbolLine(nativeSymbol);
      if (line && !nativeDeclSymbols.has(line)) nativeDeclSymbols.set(line, nativeSymbol);
    }
    let declLine = null;
    let declCol = null;
    let declContent = '';
    let declContext = [];
    let declSymbol = null;
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
          contextLines = sourceLines
            .slice(i, i + 3)
            .map((line) => String(line || '').trim())
            .filter(Boolean);
        }
        if (declLine == null && nativeDeclSymbols.has(i + 1)) {
          declLine = i + 1;
          declCol = match.index + 1;
          declContent = String(sourceLines[i] || '').trim();
          declContext = sourceLines
            .slice(i, i + 3)
            .map((l) => String(l || '').trim())
            .filter(Boolean);
          declSymbol = nativeDeclSymbols.get(i + 1);
        }
      }
      if (localHit && nativeDeclSymbols.has(i + 1)) declarationLike = true;
    }
    if (firstLine == null) continue;
    const hasDeclPos = declLine != null;
    const declLineForEnd = hasDeclPos ? declLine : firstLine;
    const endLine = _nativeEndLineForDecl(node, cleanSymbol, declLineForEnd);
    hits.push({
      rel: node.rel,
      lang: node.lang,
      line: hasDeclPos ? declLine : firstLine,
      col: hasDeclPos ? declCol : firstCol || 1,
      ...(Number.isFinite(endLine) && endLine >= declLineForEnd ? { endLine } : {}),
      declarationLike,
      matchCount,
      content: hasDeclPos ? declContent : firstContent,
      context: hasDeclPos ? declContext : contextLines,
      firstLine,
      firstCol: firstCol || 1,
      firstContent,
      firstContext: contextLines,
      ..._symbolFacts(declSymbol),
    });
  }
  if (!hits.length) return [];
  return _sortSymbolHits(hits);
}

function _pickCalleeDeclHit(hits, preferRel) {
  if (!hits?.length) return null;
  const sameFileDecl = preferRel ? hits.find((h) => h.rel === preferRel && h.declarationLike) : null;
  if (sameFileDecl) return sameFileDecl;
  const depthOf = (rel) => String(rel || '').split('/').length;
  const isCanonicalSrc = (rel) => /^src\//.test(rel || '');
  const sorted = [...hits].sort(
    (a, b) =>
      Number(b.declarationLike) - Number(a.declarationLike) ||
      Number(_isTypeDeclarationRel(a.rel)) - Number(_isTypeDeclarationRel(b.rel)) ||
      Number(isCanonicalSrc(b.rel)) - Number(isCanonicalSrc(a.rel)) ||
      depthOf(a.rel) - depthOf(b.rel) ||
      b.matchCount - a.matchCount ||
      a.rel.localeCompare(b.rel) ||
      a.line - b.line
  );
  return sorted.find((h) => h.declarationLike) || sorted[0];
}

function _resolveCalleeDeclaration(graph, name, { language = null, preferRel = null } = {}) {
  return _pickCalleeDeclHit(_findSymbolHits(graph, name, { language }), preferRel);
}

// The record facts every symbol-mode row reports: the unified kind, the
// declaration head and the export marker. Absent on a hit that no native
// symbol backs (a pure reference), which is exactly when there is nothing to
// report about a declaration.
function _symbolFacts(sym) {
  if (!sym) return {};
  const out = { symbolKind: String(sym.kind || '') || 'symbol' };
  if (typeof sym.sig === 'string' && sym.sig.trim()) out.symbolSig = sym.sig.trim();
  if (sym.exported === true) out.symbolExported = true;
  return out;
}

// `export class`, `function`, `export method` — the same leading marker the
// outline rows use, so one reading rule covers every symbol-mode output.
export function _formatSymbolFacts(hit) {
  if (!hit?.symbolKind) return '';
  return `${hit.symbolExported ? 'export ' : ''}${hit.symbolKind}`;
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
    ..._symbolFacts(sym),
  };
}

// A file/directory anchor is a SCOPE for every symbol mode, symbol_search
// included — it used to scan the whole graph and ignore the anchor entirely.
function _nodeInGraphScope(node, fileRel, scopeRelPrefix) {
  if (fileRel) return node?.rel === fileRel;
  if (scopeRelPrefix) {
    const rel = String(node?.rel || '');
    return rel === scopeRelPrefix.slice(0, -1) || rel.startsWith(scopeRelPrefix);
  }
  return true;
}

function _collectNativeKeywordSymbolEntries(
  graph,
  keyword,
  { language = null, fileRel = null, scopeRelPrefix = null } = {}
) {
  const lowerKey = String(keyword || '').toLowerCase();
  if (!lowerKey) return [];
  const keyTokens = _tokenizeKeyword(keyword);
  const byName = new Map();
  for (const node of graph?.nodes?.values?.() || []) {
    if (language && node.lang !== language) continue;
    if (!_nodeInGraphScope(node, fileRel, scopeRelPrefix)) continue;
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

// ── declarations outside a requested scope ─────────────────────────────────
// A `file`/`files` anchor scopes the answer, so the only hit inside it is
// regularly the IMPORT of a symbol declared elsewhere. Reporting that as "no
// user declaration found; likely a global/builtin" is wrong twice over: the
// symbol is a project symbol, and its declaration is one hop away.
//
// Resolution order — the MODULE THE SCOPE ASKED ABOUT first: the file the
// scoped import points at, then any declaration the graph knows outside the
// scope, then the unresolved import target as path text. Ranking the graph
// first answered with a same-named declaration from an unrelated package
// whenever one existed, which is precisely the file the caller did NOT import.
// Returns null only when nothing in the scope imports the symbol and no
// declaration exists — the one case where the builtin wording still holds.
const _IMPORT_SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/,
];

function _importedSpecifierForSymbol(graph, node, symbol) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return null;
  const mention = new RegExp(_unicodeBoundaryPattern(escaped, node?.lang, symbol), 'u');
  for (const line of _getSourceLinesForNode(graph, node)) {
    // `export { x } from './y'` is an import edge too — a re-export barrel is
    // exactly the kind of file a scoped query lands in.
    if (!/\b(?:import|require|export)\b/.test(line)) continue;
    if (!mention.test(line)) continue;
    for (const pattern of _IMPORT_SPECIFIER_PATTERNS) {
      const match = pattern.exec(line);
      if (match) return match[1];
    }
  }
  return null;
}

// A dependency tree is not this project's source: it is excluded from the
// graph, and indexing one file out of it to answer a path question would pull
// in a tree the caller never asked to index.
export function _isVendorPath(value) {
  return /(?:^|[\\/])node_modules[\\/]/.test(String(value || ''));
}

// An import specifier is written without an extension (`./x`, `./dir`), so the
// file it names has to be recovered before it can be reported: the raw
// `./x` path exists nowhere, and printing it sends the caller to a file that
// is not there. Candidates are checked against the GRAPH first (a full graph
// answers without touching the disk) and only then against the filesystem,
// which is what a single-file scoped graph needs.
const _SPECIFIER_EXTENSIONS = ['.mjs', '.js', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json'];

function _specifierCandidates(abs) {
  return [
    abs,
    ..._SPECIFIER_EXTENSIONS.map((ext) => `${abs}${ext}`),
    ..._SPECIFIER_EXTENSIONS.map((ext) => pathResolve(abs, `index${ext}`)),
  ];
}

function _isExistingFile(abs) {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

// Relative specifiers only: a bare package name (or an unresolved TS path
// alias) is not a file of this project, so there is nothing to point at.
function _specifierTarget(graph, node, specifier) {
  const value = String(specifier || '');
  if (!value.startsWith('./') && !value.startsWith('../')) return null;
  const cwd = graph?.cwd || '';
  const base = pathResolve(pathDirname(String(node?.abs || '')), value);
  const hasExtension = /\.[A-Za-z0-9]+$/.test(pathBasename(base));
  const candidates = hasExtension ? [base] : _specifierCandidates(base);
  for (const abs of candidates) {
    const rel = normalizeOutputPath(_graphRel(abs, cwd));
    if (graph?.nodes?.has(rel)) return { abs, rel };
  }
  for (const abs of candidates) {
    if (_isVendorPath(abs)) break;
    if (!existsSync(abs) || !_isExistingFile(abs)) continue;
    return { abs, rel: normalizeOutputPath(_graphRel(abs, cwd)) };
  }
  // Nothing resolved: report the literal target rather than inventing one.
  return { abs: base, rel: normalizeOutputPath(_graphRel(base, cwd)) };
}

export function _declarationOutsideScope(
  graph,
  symbol,
  { language = null, fileRel = null, scopeRelPrefix = null } = {}
) {
  if (!graph?.nodes || (!fileRel && !scopeRelPrefix)) return null;
  const name = String(symbol || '').trim();
  if (!name) return null;
  let viaImport = null;
  let unresolvedSpecifier = '';
  for (const node of graph.nodes.values()) {
    if (!_nodeInGraphScope(node, fileRel, scopeRelPrefix)) continue;
    const specifier = _importedSpecifierForSymbol(graph, node, name);
    if (!specifier) continue;
    const target = _specifierTarget(graph, node, specifier);
    if (!target) {
      // A bare/aliased specifier names a module this project cannot resolve —
      // still an import, so the builtin verdict below must not be reached.
      if (!unresolvedSpecifier) unresolvedSpecifier = specifier;
      continue;
    }
    const known = graph.nodes.get(target.rel);
    const knownSymbols = known && Array.isArray(known.symbols) ? known.symbols : [];
    const declared = knownSymbols.find((item) => item?.name === name);
    if (declared) {
      return {
        rel: target.rel,
        line: _symbolLine(declared),
        lang: known.lang || '',
        facts: _formatSymbolFacts({ ..._symbolFacts(declared) }),
      };
    }
    // A barrel that re-exports without declaring resolves through the graph
    // below; keep the path as the last resort.
    if (!viaImport) viaImport = { rel: target.rel, abs: target.abs, viaImport: true, line: 0, lang: '', facts: '' };
  }
  const outside = _findSymbolHits(graph, name, { language }).filter(
    (hit) => hit.declarationLike && !_nodeInGraphScope({ rel: hit.rel }, fileRel, scopeRelPrefix)
  );
  if (outside.length) {
    const hit = outside[0];
    return {
      rel: hit.rel,
      line: Number(hit.line) || 0,
      lang: hit.lang || '',
      facts: _formatSymbolFacts(hit),
    };
  }
  if (viaImport) return viaImport;
  if (unresolvedSpecifier) return { specifier: unresolvedSpecifier, line: 0, lang: '', facts: '' };
  return null;
}

export function _formatOutsideDeclaration(outside) {
  if (outside?.specifier && !outside?.rel) {
    return `imported from '${outside.specifier}' (specifier does not resolve to a file of this project)`;
  }
  if (!outside?.rel) return '';
  if (!outside.line) return `${outside.rel} (resolved from the import specifier)`;
  const facts = [outside.lang, outside.facts].filter(Boolean).join(', ');
  return `${outside.rel}:${outside.line}${facts ? ` (${facts})` : ''}`;
}

// One row per matched symbol: name, location, then the record facts —
// `kind[ export]` and the declaration head when the record carries one.
function _formatSearchSymbolRow(name, hit) {
  const loc = hit ? _formatSymbolHitLocation(hit) : '(unresolved)';
  const facts = _formatSymbolFacts(hit);
  const sig = hit?.symbolSig ? `\t${hit.symbolSig}` : '';
  return `${name}\t${loc}${facts ? `\t${facts}` : ''}${sig}`;
}

const KEYWORD_SEARCH_CACHE_MAX_ENTRIES = Math.max(
  16,
  Math.floor(Number(process.env.CODE_GRAPH_KEYWORD_SEARCH_CACHE_MAX_ENTRIES) || 128)
);
const KEYWORD_SEARCH_CACHE_MAX_BYTES = Math.max(
  64 * 1024,
  Math.floor(Number(process.env.CODE_GRAPH_KEYWORD_SEARCH_CACHE_MAX_BYTES) || 1024 * 1024)
);

function _keywordSearchLanguageCacheKey(language) {
  return language == null ? '<none>' : `lang:${String(language)}`;
}

function _setKeywordSearchCache(graph, cacheKey, value) {
  const cache = graph?._keywordSearchCache;
  if (!(cache instanceof Map)) return value;
  const valueBytes = Buffer.byteLength(String(value || ''), 'utf8');
  if (valueBytes > KEYWORD_SEARCH_CACHE_MAX_BYTES) return value;
  if (cache.has(cacheKey)) cache.delete(cacheKey);
  cache.set(cacheKey, value);
  let totalBytes = 0;
  for (const memo of cache.values()) totalBytes += Buffer.byteLength(String(memo || ''), 'utf8');
  while (cache.size > KEYWORD_SEARCH_CACHE_MAX_ENTRIES || totalBytes > KEYWORD_SEARCH_CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const oldValue = cache.get(oldest);
    totalBytes -= Buffer.byteLength(String(oldValue || ''), 'utf8');
    cache.delete(oldest);
  }
  return value;
}

export function _searchSymbolsByKeyword(
  graph,
  keyword,
  cwd,
  { language = null, limit = 30, fileRel = null, scopeRelPrefix = null } = {}
) {
  const clean = String(keyword || '').trim();
  if (!clean) return '(no keyword)';
  const cap = Math.max(1, Math.min(100, Math.floor(Number(limit) || 30)));
  const scope = { language, fileRel, scopeRelPrefix };
  const scopeLabel = fileRel || scopeRelPrefix || '';
  // Memoize the full formatted output per (language, keyword, cap). Repeated
  // symbol_search scans (e.g. batched keywords) otherwise re-walk every graph
  // node — native + cheap symbol collection — for each keyword. The cached
  // string already embeds the truncated WARN line, so truncated/incomplete
  // semantics are preserved byte-for-byte on a cache hit.
  const cacheKey = JSON.stringify([
    _keywordSearchLanguageCacheKey(language),
    clean,
    cap,
    fileRel || '*',
    scopeRelPrefix || '*',
  ]);
  const cached = graph?._keywordSearchCache?.get(cacheKey);
  if (typeof cached === 'string') return cached;
  const _memo = (s) => _setKeywordSearchCache(graph, cacheKey, s);
  // Native symbols are the only source: a node without them contributes no
  // keyword match (it has no declarations the extractor could name).
  const entries = _collectNativeKeywordSymbolEntries(graph, clean, scope);
  if (!entries.length) {
    const nodeCount = graph?.nodes?.size ?? 0;
    return _memo(
      `(no symbol keyword matches in cwd=${cwd}${scopeLabel ? ` scope=${scopeLabel}` : ''})\ngraph: nodes=${nodeCount}${language ? `, language=${language}` : ''}`
    );
  }
  entries.sort((a, b) => {
    const rank = Number(b.resolved) - Number(a.resolved);
    if (rank !== 0) return rank;
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
    lines.push(
      `+${unresolvedNames.length} unresolved name variants (token-only, no declaration — find_symbol will miss these; grep to locate): ${unresolvedNames.join(', ')}`
    );
  }
  if (graph?.truncated) {
    lines.push(
      `WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — matches may be incomplete. Re-run with a narrower cwd.`
    );
  }
  return _memo(lines.join('\n'));
}

export function _augmentNoHitDiagnostic(result, emptyToken, graph, cwd, symbol) {
  if (typeof result !== 'string' || result.trim() !== emptyToken) return result;
  const n = graph?.nodes?.size || 0;
  const trunc = graph?.truncated ? `, graph truncated at ${CODE_GRAPH_MAX_FILES} files` : '';
  let declHit = null;
  try {
    declHit = (_sortSymbolHits(_findSymbolHits(graph, symbol, {})) || [])[0] || null;
  } catch {}
  if (declHit) {
    return `${emptyToken}\n# '${symbol}' IS defined (${_formatSymbolHitLocation(declHit)}) but is genuinely unreferenced in this graph — present, not missing. No re-scope / grep needed.`;
  }
  return (
    `${emptyToken}\n# '${symbol}' not present in graph rooted at ${cwd} (${n} files indexed${trunc}). ` +
    `If it should exist, the target is likely outside this cwd — pass an explicit 'cwd' (repo root) or 'file' anchor, or run 'cwd set <repo>'.`
  );
}
