// Keyword-to-symbol fuzzy matching: tokenization, token-aligned contiguous
// match, ordered token match, and ranking key. Pure string helpers with no
// graph/cache state. Extracted from search.mjs.

export function _keywordSymbolSortKey(symbolName, keyword) {
  const lowerName = String(symbolName || '').toLowerCase();
  const lowerKey = String(keyword || '').toLowerCase();
  const idx = lowerName.indexOf(lowerKey);
  if (idx < 0) return null;
  const atStart = idx === 0 ? 0 : 1;
  return [lowerName.length, atStart, idx, symbolName];
}

export function _tokenizeKeyword(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function _tokenStartOffsets(sym) {
  const starts = new Set();
  let prevAlnum = false;
  let prevUpper = false;
  for (let i = 0; i < sym.length; i += 1) {
    const c = sym[i];
    const isAlnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    if (!isAlnum) { prevAlnum = false; prevUpper = false; continue; }
    const isUpper = c >= 'A' && c <= 'Z';
    if (!prevAlnum) starts.add(i);
    else if (isUpper && !prevUpper) starts.add(i);
    prevAlnum = true;
    prevUpper = isUpper;
  }
  return starts;
}

function _contiguousMatchTokenAligned(sym, lowerKey) {
  const len = lowerKey.length;
  if (!len) return false;
  const symLower = sym.toLowerCase();
  const starts = _tokenStartOffsets(sym);
  let lead = 0;
  while (lead < len) {
    const c = lowerKey[lead];
    const isAlnum = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    if (isAlnum) break;
    lead += 1;
  }
  let from = 0;
  for (;;) {
    const idx = symLower.indexOf(lowerKey, from);
    if (idx < 0) return false;
    const end = idx + len;
    const effectiveIdx = idx + lead;
    if (starts.has(effectiveIdx)) return true;
    let interiorBoundary = false;
    for (const s of starts) {
      if (s > effectiveIdx && s < end) { interiorBoundary = true; break; }
    }
    if (!interiorBoundary) return true;
    from = idx + 1;
  }
}

function _orderedTokenMatch(symLower, tokens) {
  let from = 0;
  for (const t of tokens) {
    const i = symLower.indexOf(t, from);
    if (i < 0) return false;
    from = i + t.length;
  }
  return true;
}

export function _keywordMatchesSymbolName(name, lowerKey, keyTokens) {
  const sym = String(name || '').trim();
  if (!sym || !lowerKey) return false;
  if (_contiguousMatchTokenAligned(sym, lowerKey)) return true;
  return keyTokens.length >= 2 && _orderedTokenMatch(sym.toLowerCase(), keyTokens);
}
