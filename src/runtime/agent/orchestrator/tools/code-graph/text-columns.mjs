// Column/byte-offset conversions, enclosing-symbol lookup and the outline
// containment tree. Pure over {node,sourceText,line,col}; no graph/cache state.
import { FUNCTION_LIKE_SYMBOL_KINDS } from './constants.mjs';

export function _toByteColumn(lineText, charCol) {
  if (!Number.isFinite(charCol) || charCol < 1) return charCol;
  const prefix = String(lineText || '').slice(0, charCol - 1);
  return Buffer.byteLength(prefix, 'utf8') + 1;
}

export function _nearestEnclosingSymbol(node, sourceText, lineNumber, col = null) {
  const FUNCTION_LIKE = FUNCTION_LIKE_SYMBOL_KINDS;
  const symbols = Array.isArray(node?.symbols) ? node.symbols : [];
  const inRange = (item) => {
    const start = Number(item.line ?? item.startLine);
    if (start > lineNumber || Number(item.endLine) < lineNumber) return false;
    if (col != null) {
      const sl = Number(item.startLine);
      const sc = Number(item.startCol);
      const ec = Number(item.endCol);
      if (Number.isFinite(sl) && sl === lineNumber && Number.isFinite(sc) && col < sc) return false;
      if (Number(item.endLine) === lineNumber && Number.isFinite(ec) && col > ec) return false;
    }
    return true;
  };
  const candidates = symbols
    .filter(inRange)
    .sort((a, b) => (Number(b.line ?? b.startLine) - Number(a.line ?? a.startLine)) || ((Number(b.startCol) || 0) - (Number(a.startCol) || 0)));
  const fn = candidates.find((item) => FUNCTION_LIKE.has(String(item.kind || '').toLowerCase()));
  return fn || candidates[0] || null;
}

function _rangeContainsSymbol(outer, inner) {
  const outerStart = Number(outer?.startLine ?? outer?.line);
  const outerEnd = Number(outer?.endLine ?? outer?.startLine ?? outer?.line);
  const innerStart = Number(inner?.startLine ?? inner?.line);
  const innerEnd = Number(inner?.endLine ?? inner?.startLine ?? inner?.line);
  if (![outerStart, outerEnd, innerStart, innerEnd].every(Number.isFinite)) return false;
  if (outerStart > innerStart || outerEnd < innerEnd) return false;
  if (outerStart === innerStart && outerEnd === innerEnd) {
    const outerCol = Number(outer?.startCol) || 0;
    const innerCol = Number(inner?.startCol) || 0;
    return outerCol < innerCol;
  }
  return true;
}

// ── outline containment tree (record v2 `parent`) ──────────────────────────
// `parent` is the innermost enclosing symbol NAME, so the owner is resolved by
// name and disambiguated by span when a file declares that name several times
// (two `run` methods in two classes). Line spans are never used to GUESS a
// parent the record does not claim: a symbol without `parent` is top level,
// exactly as the extractor says (Rust impl members included).
//
// Memoized per `node.symbols` array: every outline/render pass over a file
// would otherwise rebuild the same index.
const _parentIndexCache = new WeakMap();

export function _symbolParentIndex(node) {
  const symbols = Array.isArray(node?.symbols) ? node.symbols : [];
  if (!symbols.length) return new Map();
  const cached = _parentIndexCache.get(symbols);
  if (cached) return cached;
  const byName = new Map();
  for (const symbol of symbols) {
    const name = String(symbol?.name || '');
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(symbol);
  }
  const parentOf = new Map();
  for (const symbol of symbols) {
    const parentName = typeof symbol?.parent === 'string' ? symbol.parent : '';
    if (!parentName) continue;
    const candidates = (byName.get(parentName) || []).filter((item) => item !== symbol);
    if (!candidates.length) continue;
    let owner = null;
    for (const candidate of candidates) {
      if (!_rangeContainsSymbol(candidate, symbol)) continue;
      const ownerStart = Number(owner?.startLine ?? owner?.line);
      const candidateStart = Number(candidate.startLine ?? candidate.line);
      if (!owner || candidateStart > ownerStart) owner = candidate;
    }
    // One candidate and no usable span still nests: the record named it.
    if (!owner && candidates.length === 1) owner = candidates[0];
    if (owner) parentOf.set(symbol, owner);
  }
  _parentIndexCache.set(symbols, parentOf);
  return parentOf;
}

// Depth cap guards against a pathological/cyclic chain; real outlines are a
// handful of levels deep.
const _SYMBOL_DEPTH_MAX = 16;

export function _symbolAncestors(node, symbol, parentOf = _symbolParentIndex(node)) {
  const chain = [];
  const seen = new Set([symbol]);
  let current = parentOf.get(symbol);
  while (current && !seen.has(current) && chain.length < _SYMBOL_DEPTH_MAX) {
    chain.unshift(current);
    seen.add(current);
    current = parentOf.get(current);
  }
  return chain;
}

export function _symbolLevel(node, symbol, parentOf = _symbolParentIndex(node)) {
  return _symbolAncestors(node, symbol, parentOf).length;
}

export function _symbolPathForSymbol(node, symbol) {
  if (!symbol?.name) return '';
  return [..._symbolAncestors(node, symbol), symbol].map((item) => item.name).join('/');
}

export function _symbolPathForPosition(node, sourceText, lineNumber, col = null) {
  const symbol = _nearestEnclosingSymbol(node, sourceText, lineNumber, col);
  return symbol ? _symbolPathForSymbol(node, symbol) : '';
}
