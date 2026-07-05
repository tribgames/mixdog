// Identifier tokenization, cheap regex symbol extraction, lazy per-symbol
// candidate-node lookup, and explainer anchor lines. Extracted verbatim
// from code-graph.mjs.
import {
  _langUsesDollarInIdentifiers,
  _langAllowsBangQuestionSuffix,
} from './lang-predicates.mjs';
import { _getSourceTextForNode } from './source-access.mjs';
import { _graphRel } from './source-access.mjs';

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

export function _extractIdentifierTokens(text, lang = null) {
  const out = new Set();
  const allowDollar = !lang || _langUsesDollarInIdentifiers(lang);
  const before = allowDollar ? '(?<![\\p{ID_Continue}$])' : '(?<![\\p{ID_Continue}])';
  const suffix = lang && _langAllowsBangQuestionSuffix(lang) ? '[!?]?' : '';
  const after = allowDollar ? '(?![\\p{ID_Continue}$])' : '(?![\\p{ID_Continue}])';
  const re = new RegExp(`${before}[$@]?[\\p{ID_Start}_][\\p{ID_Continue}]*${suffix}${after}`, 'gu');
  let match = null;
  const src = String(text || '');
  while ((match = re.exec(src))) {
    out.add(match[0]);
  }
  return [...out];
}

export function _getTokenSymbolsForNode(graph, node) {
  if (Array.isArray(node?.tokenSymbols)) return node.tokenSymbols;
  const text = _getSourceTextForNode(graph, node);
  const tokens = _extractIdentifierTokens(text, node.lang);
  node.tokenSymbols = tokens;
  return tokens;
}

// Lazy per-symbol candidate lookup. Caches the result back into
// `_symbolTokenIndex` so repeat lookups are O(1). Compared to a full
// _ensureSymbolTokenIndex sweep, the per-symbol scan is O(N) where N is
// the node count (~7000 on refs/), and each node's check is a cheap
// Array.includes on its pre-extracted tokenSymbols. Cold-process first
// lookup drops from ~1-2s to ~50ms.
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
    const tokens = _getTokenSymbolsForNode(graph, node);
    if (tokens.includes(symbol)) candidates.push(node);
  }
  if (candidates.length > 0) {
    if (graph._symbolTokenIndex) {
      graph._symbolTokenIndex.set(cacheKey, candidates.map((n) => n.rel));
    }
    return candidates;
  }
  // Token-index miss → fall back to language-filtered full graph scan.
  // _extractIdentifierTokens uses ASCII `\b` word-boundary which misses
  // unicode (Korean/CJK), $-prefixed identifiers in some positions, and
  // certain multi-byte language tokens (Rust raw idents, Go method
  // receivers). The downstream search loop's sourceText.includes()
  // still catches these — we just need to give it the full node set.
  // Not cached: caching the fallback would mask token-extractor
  // improvements and would also keep returning the heavy scan after a
  // future graph rebuild populated the token map for the symbol.
  const fallback = [];
  for (const node of graph.nodes.values()) {
    if (language && node.lang !== language) continue;
    fallback.push(node);
  }
  return fallback;
}

export function _extractSymbolsCheap(text, lang) {
  const all = _collectCheapSymbols(text, lang).map((item) => `${item.kind} ${item.name} (L${item.line})`);
  return all.length ? _capGraphList(all).join('\n') : '(no symbols)';
}

// Control-flow keywords that the bare `name(args) {?$` patterns below
// would otherwise mis-collect as function/method symbols (e.g. an
// `if (...) {` line). Excluding at the collection stage keeps the
// invariant out of every downstream label/summarizer.
const _CHEAP_SYMBOL_CONTROL_FLOW = new Set([
  'if', 'else', 'elif', 'for', 'foreach', 'while', 'do',
  'switch', 'case', 'default', 'when', 'select',
  'try', 'catch', 'finally', 'throw', 'throws',
  'return', 'yield', 'await', 'goto', 'break', 'continue',
  'with', 'using', 'lock', 'synchronized', 'unless',
]);

export function _collectCheapSymbols(text, lang) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const push = (kind, name, idx) => {
    if (!name) return;
    // Skip control-flow keywords so `if(...) {`, `for(...) {`,
    // `while(...) {`, `switch(...) {`, `catch(...) {` no longer leak
    // as function/method symbols through the bare `name(args)` shapes.
    if (_CHEAP_SYMBOL_CONTROL_FLOW.has(name)) return;
    out.push({ kind, name, line: idx + 1 });
  };
  // Slash (`//` `/*`) comments: all C-family langs incl. new kotlin/swift/
  // scala. Excluded: python/ruby (hash), bash (hash), lua (`--`; also `//`
  // is lua integer-division, so slash-stripping would delete code). Second
  // batch: dart/objc/zig are C-family slash-comment (kept by the default);
  // elixir/r are hash-comment (excluded below).
  const supportsSlash = lang !== 'python' && lang !== 'ruby'
    && lang !== 'bash' && lang !== 'lua'
    && lang !== 'elixir' && lang !== 'r';
  // Hash (`#`) comments: python/ruby/php and bash. lua uses `--` (handled by
  // _maskNonCodeText, not needed here since lua has no cheap-symbol matcher).
  // Second batch: elixir and r are `#`-only line-comment langs → included.
  const supportsHash = lang === 'python' || lang === 'ruby' || lang === 'php'
    || lang === 'bash' || lang === 'elixir' || lang === 'r';
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    // Per-line comment stripping at the collection stage so header/JSDoc
    // words like "These", "side", "effects" cannot bleed into the
    // overview `symbols:` token list or the cheap summarizer output.
    // An unclosed `/*` keeps the code before it and flips the block flag
    // so code-before-comment lines (and spaced generators like `* gen()`)
    // still reach the per-language matchers below.
    let line = lines[i];
    if (supportsSlash) {
      if (inBlockComment) {
        const endIdx = line.indexOf('*/');
        if (endIdx < 0) continue;
        line = line.slice(endIdx + 2);
        inBlockComment = false;
      }
      while (true) {
        const startIdx = line.indexOf('/*');
        if (startIdx < 0) break;
        const endIdx = line.indexOf('*/', startIdx + 2);
        if (endIdx < 0) {
          line = line.slice(0, startIdx);
          inBlockComment = true;
          break;
        }
        line = line.slice(0, startIdx) + ' ' + line.slice(endIdx + 2);
      }
      const slashIdx = line.indexOf('//');
      if (slashIdx >= 0) line = line.slice(0, slashIdx);
    }
    if (supportsHash) {
      if (/^\s*#/.test(line)) continue;
    }
    if (!line.trim()) continue;
    let m = null;
    if (lang === 'typescript' || lang === 'javascript') {
      if ((m = /\b(class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
      else if ((m = /\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line))) push('binding', m[1], i);
      else if ((m = /^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('method', m[1], i);
    } else if (lang === 'python') {
      if ((m = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('class', m[1], i);
      else if ((m = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('function', m[1], i);
    } else if (lang === 'go') {
      if ((m = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/.exec(line))) push('struct', m[1], i);
      else if ((m = /^\s*func(?:\s*\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
    } else if (lang === 'rust') {
      if ((m = /^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('struct', m[1], i);
      else if ((m = /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
    } else if (lang === 'kotlin') {
      // Kotlin: `fun name(...)` is the canonical function declaration whether
      // the body is a `{` block or an `= expr` expression body. The shared
      // Java/C#-style `name(...) {` pattern misses expression bodies that
      // end with the expression itself (no trailing `{` or `;`), so caller
      // names disappear for those functions.
      if ((m = /\b(class|interface|enum|object)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:open\s+|abstract\s+|final\s+)?(?:override\s+)?(?:suspend\s+)?(?:inline\s+)?fun\s+(?:<[^>]+>\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
      else if ((m = /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:const\s+)?(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line))) push('binding', m[1], i);
    } else if (lang === 'java' || lang === 'csharp') {
      if ((m = /\b(class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('function', m[1], i);
    } else if (lang === 'c' || lang === 'cpp') {
      if ((m = /\b(class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /^\s*[A-Za-z_][\w\s:*<>~]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('function', m[1], i);
    } else if (lang === 'ruby' || lang === 'php') {
      if ((m = /^\s*class\s+([A-Za-z_][A-Za-z0-9_:]*)/.exec(line))) push('class', m[1], i);
      else if ((m = /^\s*def\s+([A-Za-z_][A-Za-z0-9_!?=]*)/.exec(line))) push('function', m[1], i);
    }
    // No cheap-regex matcher for swift/scala/bash/lua or the second batch
    // (dart/objc/elixir/zig/r): the native indexer now emits symbols for these
    // langs, so _collectCheapSymbols runs only as a fallback when native
    // symbols are absent. They are deliberately left without a branch (yield no
    // cheap anchors) rather than guessing with a loose pattern; callers
    // (overview/anchors) fall back to native symbols.
  }
  return out;
}

// Raised from 6 to 50 after HS-A6 surfaced that overview on a ~46KB file
// returned only the first 6 anchors (all within the first 87 lines, 5%
// of the file). tail-trim still bounds output payload, so a higher cap
// surfaces full structure on large files without hurting small ones.
export function _extractExplainerAnchorLines(node, graph, { limit = 50, maxLineChars = 180 } = {}) {
  const sourceLines = _getSourceTextForNode(graph, node).split(/\r?\n/);
  const symbols = Array.isArray(node.symbols) && node.symbols.length
    ? node.symbols
    : _collectCheapSymbols(sourceLines.join('\n'), node.lang);
  const out = [];
  const seen = new Set();
  for (const item of symbols) {
    if (out.length >= limit) break;
    const idx = item.line - 1;
    const line = String(sourceLines[idx] || '').trim();
    if (!line) continue;
    const key = `${item.name}:${item.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${item.kind} ${item.name} (L${item.line}): ${line.slice(0, maxLineChars)}`);
  }
  return out;
}

// Bound model-facing structural list output (imports/dependents/related,
// symbols, external callers) so a high fan-in/fan-out or symbol-dense file
// cannot inject an unbounded result — mirrors the find_imports/find_dependents
// cap.
export function _capGraphList(arr, cap = 200) {
  return arr.length > cap
    ? [...arr.slice(0, cap), `[truncated — showing first ${cap} of ${arr.length}]`]
    : arr;
}

export function _buildExplainerFileSummary(node, graph, cwd) {
  const topTypes = Array.isArray(node?.topLevelTypes) ? node.topLevelTypes.slice(0, 8) : [];
  const importsAll = Array.isArray(node?.resolvedImports) ? node.resolvedImports.map((p) => _graphRel(p, cwd)) : [];
  const imports = importsAll.slice(0, 8);
  const tokensAll = _getTokenSymbolsForNode(graph, node);
  // Prefer native tree-sitter symbol names; fall back to the regex token
  // dump only when the native graph path didn't populate node.symbols.
  const hasNativeSymbols = Array.isArray(node?.symbols) && node.symbols.length > 0;
  const symbolsAll = hasNativeSymbols
    ? [...new Set(node.symbols.map((s) => s.name))]
    : tokensAll;
  const symbolNames = symbolsAll.slice(0, hasNativeSymbols ? 30 : 20);
  const anchors = _extractExplainerAnchorLines(node, graph);
  const sourceHead = _getSourceTextForNode(graph, node)
    .split(/\r?\n/)
    .slice(0, 6)
    .join('\n')
    .trim()
    .slice(0, 420);
  const parts = [
    `file: ${node.rel}`,
    `language: ${node.lang}`,
  ];
  if (topTypes.length) parts.push(`top-level: ${topTypes.join(', ')}`);
  if (symbolNames.length) {
    const more = symbolsAll.length - symbolNames.length;
    parts.push(`symbols: ${symbolNames.join(', ')}${more > 0 ? `, … +${more} more (mode:symbols for full list)` : ''}`);
  }
  if (imports.length) {
    const more = importsAll.length - imports.length;
    parts.push(`imports: ${imports.join(', ')}${more > 0 ? `, … +${more} more (mode:imports for full list)` : ''}`);
  }
  if (anchors.length) parts.push(`anchors:\n${anchors.join('\n')}`);
  if (sourceHead) parts.push(`head:\n${sourceHead}`);
  return parts.join('\n');
}
