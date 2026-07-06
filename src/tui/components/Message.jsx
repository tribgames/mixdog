/**
 * components/Message.jsx — transcript message rows.
 *
 * Transcript message rows:
 *   - Assistant: `● <markdown>` where the dot is `BLACK_CIRCLE`
 *     in the `text` color (not the orange title accent), in a 2-wide gutter, and
 *     the markdown sits in a column box beside it (flexDirection row).
 *   - User: text on a `userMessageBackground` background with
 *     `paddingRight={1}` (no prompt glyph — the bg distinguishes input
 *     from assistant/tool rows).
 *
 * The dot uses `minWidth={2}` so wrapped markdown lines align under the text,
 * not under the dot (2-wide gutter alignment).
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme, TURN_MARKER } from '../theme.mjs';
import { Markdown, StreamingMarkdown, resetStreamingMarkdownStablePrefix } from './Markdown.jsx';
import { assistantBodyWidth } from '../markdown/table-layout.mjs';

// `themeEpoch` is a memo-busting prop (threaded from App): the active theme
// mutates `theme` in-place, so a /theme switch must re-render this memoized row
// and recompute its markdown colors. It is forwarded into Markdown so the
// token/AnsiText caches include it as a dep.
export const AssistantMessage = React.memo(function AssistantMessage({
  text,
  streaming = false,
  columns = 80,
  themeEpoch = 0,
  assistantId,
}) {
  // The body column needs an EXPLICIT numeric width. Without it, ink/Yoga
  // measures the wrapped markdown body before the row's available width is
  // resolved and caches its height as a single row — so a multi-line assistant
  // message renders only its LAST wrapped line (the head lines are clipped) and
  // streaming height jitters as the measure flips. Reserve the 2-col gutter
  // (BLACK CIRCLE in minWidth={2}) plus one right-edge safety cell. Letting an
  // assistant line reach the terminal's last column can auto-wrap/scroll on
  // Windows Terminal/conhost and make the next redraw appear to lose leading
  // CJK characters even though the backing transcript is intact.
  React.useEffect(() => {
    if (!streaming && assistantId) resetStreamingMarkdownStablePrefix(assistantId);
  }, [streaming, assistantId]);

  const bodyWidth = assistantBodyWidth(columns);
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexShrink={0} minWidth={2}>
        <Text color={theme.text}>{TURN_MARKER}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={0} width={bodyWidth}>
        {streaming
          ? <StreamingMarkdown themeEpoch={themeEpoch} columns={bodyWidth} streamKey={assistantId}>{text}</StreamingMarkdown>
          : <Markdown themeEpoch={themeEpoch} columns={bodyWidth}>{text}</Markdown>}
      </Box>
    </Box>
  );
});

export const UserMessage = React.memo(function UserMessage({ text, attached = false, columns, themeEpoch = 0 }) {
  // `attached` = the previous transcript row is also a user message (consecutive
  // steering prompts). Those stack flush together; a user message that follows
  // an assistant/tool row gets a one-row gap above it.
  // The background band fills the row edge-to-edge (user bubble reads as a
  // full-width band, not a text-hugging tag). An explicit numeric width is more
  // robust than "100%" here — it guarantees the band even if a parent's width
  // context is ambiguous. paddingLeft aligns the body under the 2-col gutter.
  // Stop one cell short of the right edge: writing the terminal's last column
  // makes Windows Terminal/conhost auto-wrap, which drifts the alt-screen frame
  // and stacks stale gray bands on re-render. One narrower cell is invisible.
  const bandColumns = Math.max(1, columns - 1);
  return (
    <Box flexDirection="column" width={bandColumns} marginTop={attached ? 0 : 1} backgroundColor={theme.userMessageBackground} paddingLeft={2} paddingRight={1}>
      <Text color={theme.mixdogIvory} wrap="wrap">{text}</Text>
    </Box>
  );
});

export function NoticeMessage({ text, tone, columns = 80 }) {
  const accentColor = tone === 'error' ? theme.error : tone === 'warn' ? theme.warning : theme.inactive;
  const bodyColor = tone === 'info' || tone === 'plain' ? theme.inactive : theme.statusText;
  const prefix = tone === 'plain' || tone === 'error' ? '' : '·';
  const iconWidth = prefix ? 2 : 0;
  const paddingLeft = 2;
  const rowWidth = Math.max(1, columns - 1);
  const bodyWidth = Math.max(1, rowWidth - paddingLeft - iconWidth);
  return (
    <Box marginTop={1} paddingLeft={paddingLeft} flexDirection="row" width={rowWidth}>
      {prefix ? (
        <Box flexShrink={0} width={iconWidth}>
          <Text color={accentColor}>{prefix}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" width={bodyWidth} flexShrink={0}>
        <Text color={bodyColor} wrap="wrap">{text}</Text>
      </Box>
    </Box>
  );
}
