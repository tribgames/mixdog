// Native symbol/token access: candidate-node lookup over the binary's `tokens`,
// outline rendering over the v2 `symbols` record, and the per-file overview
// summary.
//
// Symbols and tokens have NO text fallback. `node.symbols` (record v2:
// {name, kind, startLine, endLine, startCol, endCol, exported?, sig?, parent?})
// and `node.tokenSymbols` are the only sources; a node that carries neither
// contributes nothing to an outline or a candidate set. The cheap regex outline
// matchers and the JS identifier re-tokenizer that used to stand in for them
// are gone — they disagreed with the extractor, so an answer's content depended
// on which of the two produced it.
import { _langUsesDollarInIdentifiers, _langAllowsBangQuestionSuffix } from './lang-predicates.mjs';
import { EXTRACTION_SYMBOL_LANGS } from './constants.mjs';
import { _getSourceTextForNode, _graphRel } from './source-access.mjs';
import { _symbolParentIndex, _symbolLevel } from './text-columns.mjs';

// Unicode-aware word-boundary wrapper for an already-regex-escaped
// symbol. JS `\b` only fires at ASCII [A-Za-z0-9_] transitions, so
// CJK / Cyrillic / Greek identifiers never matched the legacy shape.
// `$` is part of the boundary only for JS/TS/PHP; Ruby/Kotlin/Rust
// `!?` suffixes are kept distinct from the unsuffixed name when searching.
export function _unicodeBoundaryPattern(escaped, lang = null, symbol = null) {
  const allowDollar = !lang || _langUsesDollarInIdentifiers(lang);
  const before = allowDollar ? '(?<![\\p{ID_Continue}$])' : '(?<![\\p{ID_Continue}])';
  let after = allowDollar ? '(?![\\p{ID_Continue}$])' : '(?![\\p{ID_Continue}])';
  const sym = symbol == null ? '' : String(symbol);
  if (lang && _langAllowsBangQuestionSuffix(lang) && sym && !/[!?]$/.test(sym)) {
    after = allowDollar ? '(?![\\p{ID_Continue}$!?])' : '(?![\\p{ID_Continue}!?])';
  }
  return `${before}${escaped}${after}`;
}

// Native identifier tokens of a node, or null when the binary shipped none
// (older build, un-hydrated cache entry, file it did not parse). null means
// UNKNOWN — never "no identifiers" — and there is no re-tokenization: a JS
// regex pass produced a DIFFERENT token set than the extractor, so candidate
// sets silently depended on which of the two ran.
export function _getTokenSymbolsForNode(node) {
  return Array.isArray(node?.tokenSymbols) ? node.tokenSymbols : null;
}

// Per-symbol candidate lookup over the native token lists, memoized in
// `_symbolTokenIndex` so repeat lookups are O(1). The scan is O(N) over the
// node count and each node's check is an Array.includes on its shipped tokens.
//
// A node without tokens contributes nothing, and a miss is cached as the empty
// set: the previous "no candidate → return EVERY node" fallback turned a token
// miss into a full-graph text scan, which hid missing token data behind a slow
// answer instead of reporting it.
export function _lookupCandidateNodes(graph, symbol, language = null) {
  if (!graph?.nodes) return [];
  const cacheKey = `${language || '*'}|${symbol}`;
  if (graph._symbolTokenIndex?.has(cacheKey)) {
    const rels = graph._symbolTokenIndex.get(cacheKey);
    return rels.map((rel) => graph.nodes.get(rel)).filter(Boolean);
  }
  const candidates = [];
  for (const node of graph.nodes.values()) {
    if (language && node.lang !== language) continue;
    const tokens = _getTokenSymbolsForNode(node);
    if (tokens?.includes(symbol)) candidates.push(node);
  }
  graph._symbolTokenIndex?.set(
    cacheKey,
    candidates.map((n) => n.rel)
  );
  return candidates;
}

export function _symbolLine(symbol) {
  const n = Number(symbol?.line ?? symbol?.startLine);
  return Number.isFinite(n) && n >= 1 ? n : 0;
}

// ── outline rendering (record v2) ──────────────────────────────────────────
// FIXED row grammar for `overview` and `symbols`, every language — consumers
// (the desktop editor outline parser included) read the NAME out of it:
//
//   {indent}[export ]{kind} {name} (L{start}[-{end}])[  {sig}]
//
//   export class Service (L27-45)
//     function run (L33-37)  def run(self, payload) -> str
//   variable handler (L11)
//
// - indent: two spaces per containment level, derived from `parent`.
// - export: present only for `exported: true` — one marker across languages
//   (JS/TS export, Rust pub, Python public, Java public, …), since the record
//   normalizes visibility the same way it normalizes kinds.
// - kind: the unified vocabulary, always before the name, so a row is
//   filterable without knowing the language.
// - name: the BARE symbol name, always in the same position — never the
//   signature, which is what a parser would otherwise have to split apart.
//   It is USUALLY one whitespace-free token, but the record's name is taken
//   verbatim and a few languages legitimately name a declaration with inner
//   whitespace (C++/Scala `operator ==`, and the Solidity pragma the
//   extractor records as `constant "solidity ^0.8.19"`). A consumer therefore
//   terminates the name at the trailing ` (L<start>[-<end>])` anchor — the
//   desktop outline parser's rule — instead of splitting on the first space.
// - anchor: unchanged, single line or start-end.
// - sig: appended after TWO spaces when the record carries one that adds
//   information; a sig that is just `name` or `kind name` is redundant with
//   the row itself and omitted. It never contains "(L", so the anchor stays
//   unambiguous.
//
// ONE ROW IS ONE LINE: name and sig are folded onto a single line here, so a
// record whose span text carried a newline/tab cannot split one symbol across
// two rows and desynchronize every indentation level below it.
function _symbolKindOf(symbol) {
  const kind = String(symbol?.kind || '').trim();
  return kind || 'symbol';
}

function _rowField(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function _symbolRowLabel(symbol) {
  const start = _symbolLine(symbol);
  const end = Number(symbol?.endLine);
  const range = Number.isFinite(end) && end > start ? `${start}-${end}` : `${start}`;
  const kind = _symbolKindOf(symbol);
  const name = _rowField(symbol?.name);
  const exported = symbol?.exported === true ? 'export ' : '';
  const sig = typeof symbol?.sig === 'string' ? _rowField(symbol.sig) : '';
  const redundant = !sig || sig === name || sig === `${kind} ${name}`;
  return `${exported}${kind} ${name} (L${range})${redundant ? '' : `  ${sig}`}`;
}

// Rows for one file's outline, ordered by (line, column) — the record order a
// reader follows through the file. `depth` (overview) drops rows deeper than
// that containment level; `cap` bounds the row count. Both are applied at the
// same place as before the v2 switch.
//
// A cap cuts wherever the row budget runs out — mid-class, mid-impl — so the
// truncation is ANNOUNCED. Without the marker the outline of a symbol-dense
// file (contract.ts: 137 rows, outline.rs: 136) ended at an arbitrary member
// and read like the file's complete structure. The marker sits at column 0,
// so it can never be mistaken for a nested row.
export function _symbolOutlineRows(node, { depth = null, cap = 0 } = {}) {
  const symbols = (Array.isArray(node?.symbols) ? node.symbols : []).filter(
    (symbol) => symbol?.name && _symbolLine(symbol)
  );
  if (!symbols.length) return [];
  const parentOf = _symbolParentIndex(node);
  const maxDepth = depth == null ? null : Math.max(0, Math.min(5, Math.floor(Number(depth) || 0)));
  const rows = symbols
    .map((symbol) => ({ symbol, level: _symbolLevel(node, symbol, parentOf) }))
    .filter(({ level }) => maxDepth == null || level <= maxDepth)
    .sort(
      (a, b) =>
        _symbolLine(a.symbol) - _symbolLine(b.symbol) ||
        (Number(a.symbol.startCol) || 0) - (Number(b.symbol.startCol) || 0)
    )
    .map(({ symbol, level }) => `${'  '.repeat(level)}${_symbolRowLabel(symbol)}`);
  if (cap > 0 && rows.length > cap) {
    return [...rows.slice(0, cap), `… +${rows.length - cap} more (mode:symbols for the full outline)`];
  }
  return rows;
}

// Does ANY node of this graph carry native symbols? Symbol modes have no
// fallback, so a false here is a capability failure rather than an empty
// answer — the same rule AST call sites follow.
export function _graphHasNativeSymbols(graph) {
  for (const node of graph?.nodes?.values?.() || []) {
    if (Array.isArray(node?.symbols) && node.symbols.length) return true;
  }
  return false;
}

// …but only for a file set the extractor is supposed to parse. A graph of
// pure non-extraction languages has no symbols by definition, and that is an
// answer ("(no symbols)"), not a broken binary.
export function _graphExpectsNativeSymbols(graph) {
  for (const node of graph?.nodes?.values?.() || []) {
    if (EXTRACTION_SYMBOL_LANGS.has(node?.lang)) return true;
  }
  return false;
}

// Bound model-facing structural list output (imports/dependents/related,
// symbols, external callers) so a high fan-in/fan-out or symbol-dense file
// cannot inject an unbounded result — mirrors the find_imports/find_dependents
// cap.
export function _capGraphList(arr, cap = 200) {
  return arr.length > cap ? [...arr.slice(0, cap), `[truncated — showing first ${cap} of ${arr.length}]`] : arr;
}

// Per-file overview. The outline is the native record and nothing else: a file
// the extractor produced no symbols for shows its head instead of a regex
// guess at its structure (the old `symbols:` token dump and `anchors:` block
// re-derived both from source text and disagreed with the extractor).
export function _buildExplainerFileSummary(node, graph, cwd, { depth = 1 } = {}) {
  const topTypes = Array.isArray(node?.topLevelTypes) ? node.topLevelTypes.slice(0, 8) : [];
  const importsAll = Array.isArray(node?.resolvedImports) ? node.resolvedImports.map((p) => _graphRel(p, cwd)) : [];
  const imports = importsAll.slice(0, 8);
  const outline = _symbolOutlineRows(node, { depth, cap: 120 });
  const sourceHead = _getSourceTextForNode(graph, node).split(/\r?\n/).slice(0, 6).join('\n').trim().slice(0, 420);
  const parts = [`file: ${node.rel}`, `language: ${node.lang}`];
  if (topTypes.length) parts.push(`top-level: ${topTypes.join(', ')}`);
  if (outline.length) parts.push(`outline:\n${outline.join('\n')}`);
  if (imports.length) {
    const more = importsAll.length - imports.length;
    parts.push(`imports: ${imports.join(', ')}${more > 0 ? `, … +${more} more (mode:imports for full list)` : ''}`);
  }
  if (!outline.length && sourceHead) parts.push(`head:\n${sourceHead}`);
  return parts.join('\n');
}
