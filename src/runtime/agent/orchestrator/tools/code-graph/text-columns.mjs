// Column/byte-offset conversions and enclosing-symbol lookup. Pure over
// {node,sourceText,line,col}; no graph/cache state. Extracted from search.mjs.

export function _toByteColumn(lineText, charCol) {
  if (!Number.isFinite(charCol) || charCol < 1) return charCol;
  const prefix = String(lineText || '').slice(0, charCol - 1);
  return Buffer.byteLength(prefix, 'utf8') + 1;
}

export function _byteColToCharCol(lineText, byteCol) {
  if (!Number.isFinite(byteCol) || byteCol < 1) return 1;
  const s = String(lineText || '');
  let bytes = 0;
  let k = 0;
  while (k < s.length && bytes < byteCol - 1) {
    const cp = s.codePointAt(k);
    bytes += Buffer.byteLength(String.fromCodePoint(cp), 'utf8');
    k += cp > 0xFFFF ? 2 : 1;
  }
  return k + 1;
}

export function _nearestEnclosingSymbol(node, sourceText, lineNumber, col = null) {
  const FUNCTION_LIKE = new Set([
    'function', 'method', 'arrow', 'class', 'generator', 'fn', 'async-function',
    'constructor', 'record', 'local-function',
  ]);
  const symbols = Array.isArray(node?.symbols) ? node.symbols : [];
  const inRange = (item) => {
    if (item.line > lineNumber || Number(item.endLine) < lineNumber) return false;
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
    .sort((a, b) => (b.line - a.line) || ((Number(b.startCol) || 0) - (Number(a.startCol) || 0)));
  const fn = candidates.find((item) => FUNCTION_LIKE.has(String(item.kind || '').toLowerCase()));
  return fn || candidates[0] || null;
}

function _rangeContainsSymbol(outer, inner) {
  const outerStart = Number(outer?.startLine ?? outer?.line);
  const outerEnd = Number(outer?.endLine);
  const innerStart = Number(inner?.startLine ?? inner?.line);
  const innerEnd = Number(inner?.endLine);
  if (![outerStart, outerEnd, innerStart, innerEnd].every(Number.isFinite)) return false;
  if (outerStart > innerStart || outerEnd < innerEnd) return false;
  if (outerStart === innerStart && outerEnd === innerEnd) {
    const outerCol = Number(outer?.startCol) || 0;
    const innerCol = Number(inner?.startCol) || 0;
    return outerCol < innerCol;
  }
  return outerStart < innerStart || outerEnd > innerEnd;
}

export function _symbolPathForSymbol(node, symbol) {
  if (!symbol?.name) return '';
  const ancestors = (Array.isArray(node?.symbols) ? node.symbols : [])
    .filter((candidate) => candidate !== symbol && candidate?.name && _rangeContainsSymbol(candidate, symbol))
    .sort((a, b) => {
      const aStart = Number(a.startLine ?? a.line) || 0;
      const bStart = Number(b.startLine ?? b.line) || 0;
      const aEnd = Number(a.endLine) || aStart;
      const bEnd = Number(b.endLine) || bStart;
      return (aStart - bStart) || (bEnd - aEnd) || ((Number(a.startCol) || 0) - (Number(b.startCol) || 0));
    });
  return [...ancestors, symbol].map((item) => item.name).join('/');
}

export function _symbolPathForPosition(node, sourceText, lineNumber, col = null) {
  const symbol = _nearestEnclosingSymbol(node, sourceText, lineNumber, col);
  return symbol ? _symbolPathForSymbol(node, symbol) : '';
}
