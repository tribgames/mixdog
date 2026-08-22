// Symbol search / callers / callees / references / impact query layer over a
// built graph. Pure over {graph,cwd,args}; owns no cache state. Extracted
// verbatim from code-graph.mjs.
import { readFile } from 'node:fs/promises';
import { codeGraphSourceIoAdmission } from '../../../../shared/tool-workload-gates.mjs';
import { _isJsLike, REGEX_PRECEDENT_CHARS, REGEX_PRECEDENT_KEYWORDS } from './lang-predicates.mjs';
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
import {
  _toByteColumn,
  _byteColToCharCol,
  _nearestEnclosingSymbol,
  _symbolPathForSymbol,
} from './text-columns.mjs';
import {
  _keywordSymbolSortKey,
  _tokenizeKeyword,
  _keywordMatchesSymbolName,
} from './keyword-match.mjs';

export { _formatRelated, _formatImpact, _impactSourceNodes, _findSymbolAcrossGraph, _resolveReferenceLanguageNode, _formatReferenceDetails, _formatCallerReferences, _formatTransitiveCallers } from './search-references.mjs';

// `/` at an expression position opens a RegExp literal, not a comment or a
// division. The callee body scanners below walk RAW source (the mask runs
// afterwards), so without this a literal like /[{}]/ moved the brace depth and
// truncated — or ran past — the declaration body.
// Does the `{` at `idx` open an OBJECT LITERAL (value) or a BLOCK (statement)?
// The scanners track this per brace so the matching `}` can disambiguate a
// following `/` — a line break cannot: `const x = {}\n/ 2` is still division.
const _STATEMENT_BLOCK_KEYWORDS = new Set(['else', 'do', 'try', 'finally', 'static']);

// Does the `:` at `colonIdx` belong to a ternary (value) rather than a label
// or a `case`? Scan back to the nearest statement boundary.
function _colonIsTernary(text, colonIdx) {
  // Pair colons with question marks while scanning back: a `?` only belongs to
  // OUR colon when no inner `:` has claimed it. `case c ? a : b:` therefore
  // stays a case label instead of borrowing the ternary's `?`.
  let pendingColons = 0;
  for (let i = colonIdx - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === ';' || ch === '{' || ch === '}') return false;
    if (ch === ':') { pendingColons += 1; continue; }
    if (ch === '?') {
      if (pendingColons === 0) return true;
      pendingColons -= 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let start = i;
      while (start >= 0 && /[A-Za-z0-9_$]/.test(text[start])) start -= 1;
      const word = text.slice(start + 1, i + 1);
      // `case …:` / `default:` introduce STATEMENTS, so their colon is a label.
      if (word === 'case' || word === 'default') return false;
      i = start + 1;
    }
  }
  return false;
}

export function _jsBraceKindAt(text, idx, lastClosedBraceKind = null, enclosingBraceKind = null) {
  let k = idx - 1;
  while (k >= 0 && (text[k] === ' ' || text[k] === '\t' || text[k] === '\r' || text[k] === '\n')) k -= 1;
  if (k < 0) return 'block'; // program start — statement position
  const prev = text[k];
  // `key: {…}` inside an object literal is a value; `label: {…}` and
  // `case x: {…}` inside a block are STATEMENTS, so their braces open blocks.
  if (prev === ':') {
    if (enclosingBraceKind === 'object') return 'object';
    return _colonIsTernary(text, k) ? 'object' : 'block';
  }
  // Statement boundaries and block introducers, whatever the operator table
  // says: `; {`, `{ {`, `} {`, `=> {`, `else {`.
  if (prev === ';' || prev === '{' || prev === '}') return 'block';
  if (prev === '>' && text[k - 1] === '=') return 'block';
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let s = k;
    while (s >= 0 && /[A-Za-z0-9_$]/.test(text[s])) s -= 1;
    if (_STATEMENT_BLOCK_KEYWORDS.has(text.slice(s + 1, k + 1))) return 'block';
  }
  // Otherwise decide by GRAMMATICAL POSITION rather than a character list: a
  // brace where a regex literal could start is an expression, i.e. an object
  // literal (`= {}`, `!{}`, `1 - {}`, `f({})`, `return {}`); a brace in value
  // position (`) {`, `] {`) opens a block. Sharing the test with the
  // regex/division rule keeps the two consistent by construction.
  return _atJsRegexPosition(text, idx, lastClosedBraceKind) ? 'object' : 'block';
}

export function _atJsRegexPosition(text, idx, lastClosedBraceKind = null) {
  let k = idx - 1;
  let sawNewline = false;
  while (k >= 0 && (text[k] === ' ' || text[k] === '\t' || text[k] === '\r' || text[k] === '\n')) {
    if (text[k] === '\n') sawNewline = true;
    k -= 1;
  }
  if (k < 0) return true; // start of file — statement position
  const prev = text[k];
  // `}` is ambiguous: it closes a block (statement position → regex) or an
  // object literal (value position → division, `const x = {} / 2`). The
  // scanners pass the kind of the brace that actually closed; only a stateless
  // caller falls back to the line-break heuristic.
  if (prev === '}') {
    if (lastClosedBraceKind) return lastClosedBraceKind === 'block';
    return sawNewline;
  }
  if (REGEX_PRECEDENT_CHARS.has(prev)) {
    // `a++ / b` and `a-- / b` are divisions: the operand is the postfix
    // expression, not the `+`/`-` operator this would otherwise look like.
    if ((prev === '+' || prev === '-') && text[k - 1] === prev) return false;
    return true;
  }
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let s = k;
    while (s >= 0 && /[A-Za-z0-9_$]/.test(text[s])) s -= 1;
    return REGEX_PRECEDENT_KEYWORDS.has(text.slice(s + 1, k + 1));
  }
  // Identifier / `)` / `]` / literal → value position, so `/` is division.
  return false;
}

// Index just past the closing `/flags` of the regex literal starting at `idx`.
function _skipJsRegexLiteral(text, idx) {
  let j = idx + 1;
  let inCharClass = false;
  while (j < text.length) {
    const c = text[j];
    if (c === '\n') return j; // unterminated on this line — treat as division
    if (c === '\\') { j += 2; continue; }
    if (c === '[' && !inCharClass) { inCharClass = true; j += 1; continue; }
    if (c === ']' && inCharClass) { inCharClass = false; j += 1; continue; }
    if (c === '/' && !inCharClass) {
      j += 1;
      while (j < text.length && text[j] >= 'a' && text[j] <= 'z') j += 1;
      return j;
    }
    j += 1;
  }
  return j;
}
export function _extractCallees(graph, declHit, _cwd, { cap = 200, callerSymbol = null, language = null } = {}) {
  if (!declHit || !_CALLEES_BRACE_LANGS.has(declHit.lang)) return [];
  const declNode = graph.nodes.get(declHit.rel);
  if (!declNode) return [];
  const sourceText = _getSourceTextForNode(graph, declNode);
  if (!sourceText) return [];
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
  let declColChar;
  if (nativeStartCol != null) {
    const lineEnd0 = sourceText.indexOf('\n', i);
    const lineText0 = sourceText.slice(i, lineEnd0 < 0 ? sourceText.length : lineEnd0);
    declColChar = _byteColToCharCol(lineText0, nativeStartCol);
  } else {
    declColChar = (Number.isFinite(declHit.col) && declHit.col > 1) ? declHit.col : 1;
  }
  if (declColChar > 1) {
    const lineEnd = sourceText.indexOf('\n', i);
    const maxI = lineEnd < 0 ? sourceText.length : lineEnd;
    i = Math.min(i + (declColChar - 1), maxI);
  }
  const jsLike = _isJsLike(declHit.lang);
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
    if (ch === '/' && jsLike && _atJsRegexPosition(sourceText, scanI)) {
      scanI = _skipJsRegexLiteral(sourceText, scanI);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; scanI += 1; continue; }
    if (ch === '(') { parenDepth += 1; scanI += 1; continue; }
    if (ch === ')') { if (parenDepth > 0) parenDepth -= 1; scanI += 1; continue; }
    if (ch === '{' && parenDepth === 0) { bodyStart = scanI; break; }
    if (ch === ';' && parenDepth === 0) break;
    scanI += 1;
  }
  if (bodyStart < 0) return [];
  let depth = 0;
  let bodyEnd = -1;
  inLineComment = false; inBlockComment = false; quote = '';
  // Brace context: each `{` records whether it opened a block or an object
  // literal, so the matching `}` tells a following `/` apart (regex vs
  // division) without guessing from line breaks.
  const braceKinds = [];
  let lastClosedBraceKind = null;
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
    if (ch === '/' && jsLike && _atJsRegexPosition(sourceText, j, lastClosedBraceKind)) {
      j = _skipJsRegexLiteral(sourceText, j);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; j += 1; continue; }
    if (ch === '{') {
      braceKinds.push(_jsBraceKindAt(
        sourceText,
        j,
        lastClosedBraceKind,
        braceKinds.length ? braceKinds[braceKinds.length - 1] : null,
      ));
      depth += 1;
    } else if (ch === '}') {
      lastClosedBraceKind = braceKinds.pop() || 'block';
      depth -= 1;
      if (depth === 0) { bodyEnd = j; break; }
    }
    j += 1;
  }
  if (bodyEnd < 0) bodyEnd = sourceText.length;
  const rawBody = sourceText.slice(bodyStart + 1, bodyEnd);
  const maskedBody = _maskNonCodeText(rawBody, declNode.lang);
  const bodyStartLine = sourceText.slice(0, bodyStart + 1).split('\n').length;
  const callRe = /(?<![\p{ID_Continue}$.])([\p{ID_Start}_][\p{ID_Continue}]*)(?=\s*\()/gu;
  const memberCallRe = /\.\s*\??\.?\s*([\p{ID_Start}_][\p{ID_Continue}]*)(?=\s*\()/gu;
  const seen = new Map();
  const selfName = callerSymbol || null;
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
  // One memoized declaration lookup per callee name, shared by the blacklist
  // check below and the row resolution further down.
  const declLookupCache = new Map();
  const resolveCalleeDecl = (name) => {
    if (declLookupCache.has(name)) return declLookupCache.get(name);
    let decl = null;
    try {
      decl = _resolveCalleeDeclaration(graph, name, { language, preferRel: declHit.rel });
    } catch {
      decl = null; // identifier shapes that trip the lookup regex
    }
    declLookupCache.set(name, decl);
    return decl;
  };
  const recordHit = (name, index, isMember) => {
    if (!name) return;
    if (_CALLEES_JS_KEYWORDS.has(name)) return;
    if (_isJsLike(declHit.lang)) {
      if (_CALLEES_JS_BUILTINS.has(name)) return;
      // The member blacklist exists to drop BUILT-IN methods (arr.map, set.add
      // …). A project that declares its own get/set/add/delete/find/… was
      // silenced with them, so keep any name the graph resolves to a real
      // declaration.
      if (isMember && _CALLEES_JS_METHODS.has(name)) {
        const decl = resolveCalleeDecl(name);
        if (!decl?.declarationLike) return;
      }
    }
    if (selfName && name === selfName) return;
    if (seen.has(name)) return;
    const upto = maskedBody.slice(0, index);
    const lineInBody = upto.split('\n').length - 1;
    const absLine = bodyStartLine + lineInBody;
    const absIndex = bodyStart + 1 + index;
    const lineStart = sourceText.lastIndexOf('\n', absIndex - 1) + 1;
    const charCol = absIndex - lineStart + 1;
    seen.set(name, { line: absLine, col: charCol, isMember });
  };
  let m = null;
  while ((m = callRe.exec(maskedBody))) recordHit(m[1], m.index, false);
  let mm = null;
  while ((mm = memberCallRe.exec(maskedBody))) {
    const methodStart = mm.index + mm[0].length - mm[1].length;
    recordHit(mm[1], methodStart, true);
  }
  if (seen.size === 0) return [];
  const allUnique = [...seen.entries()];
  const sliced = allUnique.slice(0, cap);
  const sourceLines = sourceText.split(/\r?\n/);
  const rows = [];
  for (const [name, info] of sliced) {
    let resolvedPath = '';
    let resolvedLine = 0;
    let resolvedDecl = false;
    try {
      const calleeDecl = resolveCalleeDecl(name);
      if (calleeDecl && calleeDecl.declarationLike) {
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

export function _formatCalleeRow(row) {
  if (row.truncationFooter) return `... ${row.snippet}`;
  const callsite = row.callsitePath ? `callsite ${row.callsitePath}:${row.callsiteLine}` : 'callsite (unknown)';
  if (row.external) {
    const enclosingExt = row.enclosing ? `(in ${row.enclosing})` : '(in ?)';
    return `${row.name}\t${callsite}\tdecl (external/builtin)\t${enclosingExt}`;
  }
  const decl = row.declPath ? `decl ${row.declPath}:${row.declLine}` : 'decl (unresolved)';
  const enclosing = row.enclosing ? `(in ${row.enclosing})` : '(in ?)';
  return `${row.name}\t${callsite}\t${decl}\t${enclosing}`;
}
const CODE_GRAPH_SOURCE_READ_CONCURRENCY = Math.max(
  1,
  Math.min(32, Math.floor(Number(process.env.MIXDOG_CODE_GRAPH_SOURCE_READ_CONCURRENCY) || 8)),
);

export async function _prewarmSourceTextNodes(graph, nodes, {
  concurrency = CODE_GRAPH_SOURCE_READ_CONCURRENCY,
  readFileImpl = readFile,
  signal = null,
  ownerKey = null,
} = {}) {
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
        const text = await codeGraphSourceIoAdmission.run(
          ownerKey,
          () => readFileImpl(node.abs, 'utf8'),
          { signal },
        );
        graph._sourceTextCache?.set(node.rel, { fingerprint: node.fingerprint || '', text });
      } catch { /* skip unreadable/aborted file */ }
    }
  };
  const workerCount = Math.min(
    Math.max(1, Math.floor(Number(concurrency) || CODE_GRAPH_SOURCE_READ_CONCURRENCY)),
    Math.max(1, uncached.length),
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

export function _cheapReferenceSearch(graph, symbol, cwd, { language = null, fileRel = null, scopeRelPrefix = null, nodes = null } = {}) {
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
  if (scopeRelPrefix) candidateNodes = candidateNodes.filter((node) => node.rel === scopeRelPrefix.slice(0, -1) || node.rel.startsWith(scopeRelPrefix));
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

export function _formatSymbolHitLocation(hit) {
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
      for (const nativeSymbol of (Array.isArray(node.symbols) ? node.symbols : [])) {
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
          context: sourceLines.slice(line - 1, line + 2).map((item) => String(item || '').trim()).filter(Boolean),
        });
      }
    }
    return _sortSymbolHits(hits);
  }
  return _findSymbolHitsOnNodes(graph, cleanSymbol, candidateNodes, { language });
}

function _findSymbolHitsOnNodes(graph, cleanSymbol, candidateNodes, { language = null } = {}) {
  if (!cleanSymbol) return [];
  const escaped = cleanSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declRe = new RegExp(
    `(?:^|[\\s;{(,])(?:export\\s+(?:default\\s+)?)?(?:public\\s+|private\\s+|protected\\s+|internal\\s+|static\\s+|abstract\\s+|final\\s+|sealed\\s+|virtual\\s+|override\\s+|async\\s+|pub\\s+(?:\\([^)]*\\)\\s+)?)*(?:const|let|var|function\\*?|class|interface|type|enum|def|func|fn|struct|union|trait|impl|mod|record|object|typedef|namespace|package)\\s+${escaped}\\b`
  );
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
// languages get a deterministic skip downstream.
export const _CALLEES_BRACE_LANGS = new Set([
  'javascript', 'typescript', 'java', 'csharp', 'kotlin', 'go',
  'rust', 'c', 'cpp', 'php', 'swift', 'scala', 'dart', 'objc', 'zig',
]);

// JS/TS reserved words / syntactic keywords that look like call expressions
// but are not function invocations.
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
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Function',
  'Set', 'Map', 'WeakSet', 'WeakMap', 'WeakRef', 'FinalizationRegistry',
  'Promise', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Proxy',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array',
  'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI',
  'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'eval',
  'globalThis', 'NaN', 'Infinity',
  'JSON', 'Math', 'Reflect', 'Atomics', 'Intl', 'console', 'process',
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'queueMicrotask', 'structuredClone', 'requestAnimationFrame',
  'cancelAnimationFrame', 'alert', 'confirm', 'prompt',
  'require',
]);

export function _pickCalleeDeclHit(hits, preferRel) {
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

// A file/directory anchor is a SCOPE for every symbol mode, symbol_search
// included — it used to scan the whole graph and ignore the anchor entirely.
export function _nodeInGraphScope(node, fileRel, scopeRelPrefix) {
  if (fileRel) return node?.rel === fileRel;
  if (scopeRelPrefix) {
    const rel = String(node?.rel || '');
    return rel === scopeRelPrefix.slice(0, -1) || rel.startsWith(scopeRelPrefix);
  }
  return true;
}

function _collectNativeKeywordSymbolEntries(graph, keyword, { language = null, fileRel = null, scopeRelPrefix = null } = {}) {
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

function _collectCheapKeywordSymbolEntries(graph, keyword, { language = null, fileRel = null, scopeRelPrefix = null } = {}) {
  const lowerKey = String(keyword || '').toLowerCase();
  if (!lowerKey) return [];
  const keyTokens = _tokenizeKeyword(keyword);
  const entries = [];
  for (const node of graph?.nodes?.values?.() || []) {
    if (language && node.lang !== language) continue;
    if (!_nodeInGraphScope(node, fileRel, scopeRelPrefix)) continue;
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
  return `${name}\t${loc}`;
}

const KEYWORD_SEARCH_CACHE_MAX_ENTRIES = Math.max(
  16,
  Math.floor(Number(process.env.CODE_GRAPH_KEYWORD_SEARCH_CACHE_MAX_ENTRIES) || 128),
);
const KEYWORD_SEARCH_CACHE_MAX_BYTES = Math.max(
  64 * 1024,
  Math.floor(Number(process.env.CODE_GRAPH_KEYWORD_SEARCH_CACHE_MAX_BYTES) || (1024 * 1024)),
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

export function _searchSymbolsByKeyword(graph, keyword, cwd, { language = null, limit = 30, fileRel = null, scopeRelPrefix = null } = {}) {
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
    _keywordSearchLanguageCacheKey(language), clean, cap, fileRel || '*', scopeRelPrefix || '*',
  ]);
  const cached = graph?._keywordSearchCache?.get(cacheKey);
  if (typeof cached === 'string') return cached;
  const _memo = (s) => _setKeywordSearchCache(graph, cacheKey, s);
  const nativeEntries = _collectNativeKeywordSymbolEntries(graph, clean, scope);
  const cheapEntries = _collectCheapKeywordSymbolEntries(graph, clean, scope);
  const entries = [...nativeEntries, ...cheapEntries];
  if (!entries.length) {
    const nodeCount = graph?.nodes?.size ?? 0;
    return _memo(`(no symbol keyword matches in cwd=${cwd}${scopeLabel ? ` scope=${scopeLabel}` : ''})\ngraph: nodes=${nodeCount}${language ? `, language=${language}` : ''}`);
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
    lines.push(`+${unresolvedNames.length} unresolved name variants (token-only, no declaration — find_symbol will miss these; grep to locate): ${unresolvedNames.join(', ')}`);
  }
  if (graph?.truncated) {
    lines.push(`WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — matches may be incomplete. Re-run with a narrower cwd.`);
  }
  return _memo(lines.join('\n'));
}

export function _augmentNoHitDiagnostic(result, emptyToken, graph, cwd, symbol) {
  if (typeof result !== 'string' || result.trim() !== emptyToken) return result;
  const n = graph?.nodes?.size || 0;
  const trunc = graph?.truncated ? `, graph truncated at ${CODE_GRAPH_MAX_FILES} files` : '';
  let declHit = null;
  try { declHit = (_sortSymbolHits(_findSymbolHits(graph, symbol, {})) || [])[0] || null; } catch {}
  if (declHit) {
    return `${emptyToken}\n# '${symbol}' IS defined (${_formatSymbolHitLocation(declHit)}) but is genuinely unreferenced in this graph — present, not missing. No re-scope / grep needed.`;
  }
  return `${emptyToken}\n# '${symbol}' not present in graph rooted at ${cwd} (${n} files indexed${trunc}). `
    + `If it should exist, the target is likely outside this cwd — pass an explicit 'cwd' (repo root) or 'file' anchor, or run 'cwd set <repo>'.`;
}
