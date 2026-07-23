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
import React from 'react';
import { Box, Text } from 'ink';
import {
  renderTokenAnsiSegments,
} from '../markdown/render-ansi.mjs';
import { resolveStreamingMarkdownParts } from '../markdown/streaming-markdown.mjs';
import { AnsiText } from './AnsiText.jsx';
import { MarkdownTable } from './MarkdownTable.jsx';
import { theme } from '../theme.mjs';

export {
  balanceStreamingMarkdown,
  resolveStreamingMarkdownParts,
  resetStreamingMarkdownStablePrefix,
  resetAllStreamingMarkdownStablePrefixes,
  streamingLayoutText,
  windowPlainStreamingText,
} from '../markdown/streaming-markdown.mjs';
export {
  measureMarkdownRenderedRows,
  measureStreamingMarkdownRenderedRows,
} from '../markdown/measure-rendered-rows.mjs';

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

const StableMarkdownChunk = React.memo(function StableMarkdownChunk({
  text,
  themeEpoch,
  columns,
}) {
  return <Markdown themeEpoch={themeEpoch} columns={columns}>{text}</Markdown>;
});

export function StreamingMarkdown({ children, themeEpoch = 0, columns, streamKey }) {
  const parts = resolveStreamingMarkdownParts(children, streamKey);
  if (parts.plain) {
    // Plain streaming text has no markdown tokens to style. Sending a growing
    // multi-line tail through renderTokenAnsiSegments/marked on every delta
    // reparses the whole response and dominates frame time; Ink can wrap the
    // identical visible text directly.
    return <Text color={theme.text} wrap="wrap">{parts.unstableForRender}</Text>;
  }
  const stableChunks = parts.stableChunks?.length
    ? parts.stableChunks
    : parts.stablePrefix ? [parts.stablePrefix] : [];
  return (
    <Box flexDirection="column" gap={1}>
      {stableChunks.map((text, index) => (
        <StableMarkdownChunk key={`stable-${index}`} text={text}
          themeEpoch={themeEpoch} columns={columns} />
      ))}
      {parts.unstableSuffix
        ? <Markdown themeEpoch={themeEpoch} columns={columns} trimPartialFences>{parts.unstableForRender}</Markdown>
        : null}
    </Box>
  );
}
