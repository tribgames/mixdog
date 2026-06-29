/**
 * markdown/render-ansi.mjs — markdown → token + ANSI helpers (no JSX).
 *
 * The lexing/token-cache and the partial-fence trim decision live here, free of
 * the ink/JSX render stack, so the exact streaming-vs-stable token path the
 * <Markdown> component renders is unit-testable without an ink renderer.
 *
 *   - lexMarkdown(content, { trimPartialFences }) → marked tokens. Stable
 *     (non-streaming) content is cached; the streaming suffix is lexed fresh and
 *     trimmed (a partial closing fence is dropped) and never cached, so trimming
 *     can never corrupt the shared cache used by stable text.
 *   - renderTokenAnsiSegments(content, opts) → array of { type, ansi?, token }
 *     describing what the component emits: 'table' segments carry the token for
 *     MarkdownTable; 'ansi' segments carry the formatToken() string.
 */
import { marked } from 'marked';
import { formatToken } from './format-token.mjs';
import { trimPartialClosingFences } from './stream-fence.mjs';

const TOKEN_CACHE_MAX = 500;
const tokenCache = new Map();
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;

let _configured = false;
export function configureMarked() {
  if (_configured) return;
  _configured = true;
  // Disable strikethrough: models use ~ for "approximate" (~100), not <del>.
  marked.use({ tokenizer: { del() { return undefined; } } });
}

export function hasMarkdownSyntax(text) {
  const value = String(text ?? '');
  const sample = value.length > 500 ? value.slice(0, 500) : value;
  return MD_SYNTAX_RE.test(sample);
}

export function lexMarkdown(content, { trimPartialFences = false } = {}) {
  configureMarked();
  const text = String(content ?? '');
  if (!hasMarkdownSyntax(text)) {
    return [{
      type: 'paragraph',
      raw: text,
      text,
      tokens: [{ type: 'text', raw: text, text }],
    }];
  }
  // Streaming suffix: lex fresh and trim a partial closing fence so an open code
  // block does not include a lone trailing backtick as a body line. These tokens
  // are transient per-delta and trimming mutates them in place, so they are NOT
  // cached — caching would corrupt the shared cache for stable text.
  if (trimPartialFences) {
    const tokens = marked.lexer(text);
    trimPartialClosingFences(tokens);
    return tokens;
  }
  const hit = tokenCache.get(text);
  if (hit) {
    tokenCache.delete(text);
    tokenCache.set(text, hit);
    return hit;
  }
  const tokens = marked.lexer(text);
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const first = tokenCache.keys().next().value;
    if (first !== undefined) tokenCache.delete(first);
  }
  tokenCache.set(text, tokens);
  return tokens;
}

/**
 * Render markdown to an ordered list of segments the component maps to ink:
 *   { type: 'table', token }      → <MarkdownTable token={token} />
 *   { type: 'ansi', ansi: string } → <AnsiText>{ansi}</AnsiText>
 * Blank-edge-only ansi segments are dropped (mirrors the component's pushAnsi).
 */
export function renderTokenAnsiSegments(content, opts = {}) {
  const tokens = lexMarkdown(content, opts);
  const segments = [];
  for (const token of tokens) {
    if (token.type === 'table') {
      segments.push({ type: 'table', token });
    } else if (token.type === 'space') {
      continue;
    } else {
      const ansi = String(formatToken(token) ?? '').replace(/^\n+|\n+$/g, '');
      if (!ansi) continue;
      segments.push({ type: 'ansi', ansi, token });
    }
  }
  return segments;
}
