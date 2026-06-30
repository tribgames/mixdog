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
import {
  configureMarked,
  hasMarkdownSyntax,
  renderTokenAnsiSegments,
} from '../markdown/render-ansi.mjs';
import { trimPartialClosingFences } from '../markdown/stream-fence.mjs';
import { AnsiText } from './AnsiText.jsx';
import { MarkdownTable } from './MarkdownTable.jsx';
import { theme } from '../theme.mjs';

function renderMarkdownElements(content, trimPartialFences = false, tableWidth) {
  // `tableWidth` is the App's body/content width; it doubles as the hr fill
  // width. Fall back to 80 when not provided so an hr still spans a sane rule.
  const segments = renderTokenAnsiSegments(content, { trimPartialFences, width: tableWidth || 80 });
  const result = [];
  let idx = 0;
  for (const segment of segments) {
    if (segment.type === 'table') {
      // Pass the App's body width as forceWidth so the table is laid out at the
      // SAME width the row-height estimator measures (measureMarkdownTableRows).
      // Without it MarkdownTable falls back to useStdout().columns, which on
      // win32 is frameColumns+1 — a 1-col gap that can flip the table between
      // horizontal and vertical layout and top-clip streaming output.
      result.push(<MarkdownTable key={`md_${idx++}`} token={segment.token} forceWidth={tableWidth} />);
    } else {
      // defaultColor={theme.text} keeps ANSI resets on the same dark-theme
      // foreground instead of the terminal profile's default foreground.
      result.push(
        <AnsiText key={`md_${idx++}`} defaultColor={theme.text}>{segment.ansi}</AnsiText>,
      );
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

export function Markdown({ children, themeEpoch = 0, trimPartialFences = false, columns }) {
  const elements = React.useMemo(() => {
    try {
      return renderMarkdownElements(children, trimPartialFences, columns);
    } catch {
      // Never throw into the render tree — fall back to raw text.
      return [<Text key="md_0" color={theme.text}>{String(children ?? '')}</Text>];
    }
  // themeEpoch is a memo dep so a /theme switch re-renders to ANSI with the new
  // md* colors (formatToken re-resolves its colorizers on the active theme).
  // columns is a dep so a resize re-lays-out tables at the new forceWidth.
  }, [children, themeEpoch, trimPartialFences, columns]);

  return (
    <Box flexDirection="column" gap={1}>
      {elements}
    </Box>
  );
}

export function StreamingMarkdown({ children, themeEpoch = 0, columns }) {
  const stablePrefixRef = useRef('');
  const text = String(children ?? '');

  if (!hasMarkdownSyntax(text)) {
    stablePrefixRef.current = '';
    return <Markdown themeEpoch={themeEpoch} columns={columns}>{text}</Markdown>;
  }

  if (!text.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = '';
  }

  let stablePrefix = stablePrefixRef.current;
  try {
    configureMarked();
    const boundary = stablePrefix.length;
    // Lex the still-streaming suffix and trim any partial closing fence so an
    // open code block does not grow-then-shrink as the final backtick(s)
    // stream in. Operates on a fresh lex so the shared tokenCache is untouched.
    const tokens = marked.lexer(text.substring(boundary));
    trimPartialClosingFences(tokens);
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
      {stablePrefix ? <Markdown themeEpoch={themeEpoch} columns={columns}>{stablePrefix}</Markdown> : null}
      {unstableSuffix ? <Markdown themeEpoch={themeEpoch} columns={columns} trimPartialFences>{balanceStreamingMarkdown(unstableSuffix)}</Markdown> : null}
    </Box>
  );
}
