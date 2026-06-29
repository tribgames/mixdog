/**
 * components/Markdown.jsx — markdown → ink, hybrid renderer.
 *
 * Markdown → ink hybrid renderer:
 *   - marked.lexer() produces the token stream.
 *   - Non-table tokens are rendered to ANSI strings via formatToken and emitted
 *     through <AnsiText> as styled spans.
 *   - Tables are rendered by the MarkdownTable component (proper Box layout).
 *   - Block tokens are emitted as separate Ink children so lists, code fences,
 *     and tables keep their markdown block boundaries.
 *
 * Syntax highlighting is omitted, but token cache + streaming-split are
 * kept so partial markdown does not repaint stable text on every delta.
 */
import React, { useRef } from 'react';
import { Box, Text } from 'ink';
import { marked } from 'marked';
import { formatToken } from '../markdown/format-token.mjs';
import { AnsiText } from './AnsiText.jsx';
import { MarkdownTable } from './MarkdownTable.jsx';
import { theme } from '../theme.mjs';

let _configured = false;
function configureMarked() {
  if (_configured) return;
  _configured = true;
  // Disable strikethrough: models use ~ for "approximate" (~100), not <del>.
  marked.use({ tokenizer: { del() { return undefined; } } });
}

const TOKEN_CACHE_MAX = 500;
const tokenCache = new Map();
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;

function hasMarkdownSyntax(text) {
  const sample = text.length > 500 ? text.slice(0, 500) : text;
  return MD_SYNTAX_RE.test(sample);
}

function cachedLexer(content) {
  const text = String(content ?? '');
  if (!hasMarkdownSyntax(text)) {
    return [{
      type: 'paragraph',
      raw: text,
      text,
      tokens: [{ type: 'text', raw: text, text }],
    }];
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

function renderMarkdownElements(content) {
  configureMarked();
  const tokens = cachedLexer(String(content ?? ''));
  const result = [];
  let idx = 0;
  const pushAnsi = (value) => {
    // Remove blank edge lines from token EOLs without trimming meaningful
    // indentation inside code blocks. defaultColor={theme.text} keeps ANSI
    // resets on the same dark-theme foreground instead of the terminal
    // profile's default foreground.
    const text = String(value ?? '').replace(/^\n+|\n+$/g, '');
    if (!text) return;
    result.push(<AnsiText key={`md_${idx++}`} defaultColor={theme.text}>{text}</AnsiText>);
  };
  for (const token of tokens) {
    if (token.type === 'table') {
      result.push(<MarkdownTable key={`md_${idx++}`} token={token} />);
    } else if (token.type === 'space') {
      continue;
    } else {
      pushAnsi(formatToken(token));
    }
  }
  return result;
}

function hasOpenFence(text) {
  let ticks = 0;
  let tildes = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*```/.test(line)) ticks += 1;
    if (/^\s*~~~/.test(line)) tildes += 1;
  }
  return ticks % 2 === 1 || tildes % 2 === 1;
}

function hasOpenInlineCode(text) {
  let count = 0;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch !== '`') continue;
    let run = 1;
    while (value[i + run] === '`') run += 1;
    if (run === 1) count += 1;
    i += run - 1;
  }
  return count % 2 === 1;
}

function hasUnclosedDelimiter(text, marker) {
  let count = 0;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') {
      i += 1;
      continue;
    }
    if (value.startsWith(marker, i)) {
      count += 1;
      i += marker.length - 1;
    }
  }
  return count % 2 === 1;
}

function balanceStreamingMarkdown(text) {
  const value = String(text ?? '');
  if (!value || hasOpenFence(value)) return value;
  if (hasOpenInlineCode(value)) return `${value}\``;
  let rendered = value;
  if (hasUnclosedDelimiter(rendered, '**')) rendered += '**';
  if (hasUnclosedDelimiter(rendered, '__')) rendered += '__';
  return rendered;
}

export function Markdown({ children }) {
  const elements = React.useMemo(() => {
    try {
      return renderMarkdownElements(children);
    } catch {
      // Never throw into the render tree — fall back to raw text.
      return [<Text key="md_0" color={theme.text}>{String(children ?? '')}</Text>];
    }
  }, [children]);

  return (
    <Box flexDirection="column" gap={1}>
      {elements}
    </Box>
  );
}

export function StreamingMarkdown({ children }) {
  const stablePrefixRef = useRef('');
  const text = String(children ?? '');

  if (!hasMarkdownSyntax(text)) {
    stablePrefixRef.current = '';
    return <Markdown>{text}</Markdown>;
  }

  if (!text.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = '';
  }

  let stablePrefix = stablePrefixRef.current;
  try {
    configureMarked();
    const boundary = stablePrefix.length;
    const tokens = marked.lexer(text.substring(boundary));
    let lastContentIdx = tokens.length - 1;
    while (lastContentIdx >= 0 && tokens[lastContentIdx]?.type === 'space') lastContentIdx--;
    let advance = 0;
    for (let i = 0; i < lastContentIdx; i++) {
      advance += tokens[i]?.raw?.length ?? 0;
    }
    if (advance > 0) {
      stablePrefixRef.current = text.substring(0, boundary + advance);
      stablePrefix = stablePrefixRef.current;
    }
  } catch {
    stablePrefix = '';
    stablePrefixRef.current = '';
  }

  const unstableSuffix = text.substring(stablePrefix.length);
  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix ? <Markdown>{stablePrefix}</Markdown> : null}
      {unstableSuffix ? <Markdown>{balanceStreamingMarkdown(unstableSuffix)}</Markdown> : null}
    </Box>
  );
}
