/**
 * components/Message.jsx — transcript message rows.
 *
 * Ported from Claude Code:
 *   - AssistantTextMessage.tsx: `● <markdown>` where the dot is `BLACK_CIRCLE`
 *     in the `text` color (white, NOT claude-orange), in a 2-wide gutter, and
 *     the markdown sits in a column box beside it (flexDirection row).
 *   - UserPromptMessage.tsx: text on a `userMessageBackground` background with
 *     `paddingRight={1}` (no prompt glyph — CC uses the bg to distinguish input
 *     from assistant/tool rows).
 *
 * The dot uses `minWidth={2}` so wrapped markdown lines align under the text,
 * not under the dot (CC's NoSelect minWidth={2} behavior).
 */
import React from 'react';
import { Box, Text, useAnimation } from 'ink';
import { theme, TURN_MARKER } from '../theme.mjs';
import { Markdown, StreamingMarkdown } from './Markdown.jsx';

export const AssistantMessage = React.memo(function AssistantMessage({ text, streaming = false }) {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexShrink={0} minWidth={2}>
        <Text color={theme.text}>{TURN_MARKER}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {streaming ? <StreamingMarkdown>{text}</StreamingMarkdown> : <Markdown>{text}</Markdown>}
      </Box>
    </Box>
  );
});

export const UserMessage = React.memo(function UserMessage({ text, attached = false, columns }) {
  // `attached` = the previous transcript row is also a user message (consecutive
  // steering prompts). Those stack flush together; a user message that follows
  // an assistant/tool row gets a one-row gap above it.
  // The background band fills the row edge-to-edge (CC's user bubble reads as a
  // full-width band, not a text-hugging tag). An explicit numeric width is more
  // robust than "100%" here — it guarantees the band even if a parent's width
  // context is ambiguous. paddingLeft aligns the body under the 2-col gutter.
  // Stop one cell short of the right edge: writing the terminal's last column
  // makes Windows Terminal/conhost auto-wrap, which drifts the alt-screen frame
  // and stacks stale gray bands on re-render. One narrower cell is invisible.
  const bandColumns = Math.max(1, columns - 1);
  return (
    <Box flexDirection="column" width={bandColumns} marginTop={attached ? 0 : 1} backgroundColor={theme.userMessageBackground} paddingLeft={2} paddingRight={1}>
      <Text color={theme.text} wrap="wrap">{text}</Text>
    </Box>
  );
});

function formatThinkingElapsed(ms) {
  const totalSec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ThinkingMessage({ text, elapsedMs = 0, activeSince = 0 }) {
  useAnimation({ interval: 250 });
  const liveElapsedMs = Number(elapsedMs || 0) + (activeSince ? Math.max(0, Date.now() - activeSince) : 0);
  const elapsed = liveElapsedMs > 0 ? formatThinkingElapsed(liveElapsedMs) : '';
  return (
    <Box flexDirection="column" marginTop={1} gap={1} width="100%">
      <Text>
        <Text color={theme.spinnerGlyph}>◈ </Text>
        <Text color={theme.thinkingAccent}>{`Thinking${elapsed ? ` ${elapsed}` : ''}…`}</Text>
      </Text>
      {text ? (
        <Box paddingLeft={2}>
          <Text color={theme.thinkingText} italic>{text}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function NoticeMessage({ text, tone, columns = 80 }) {
  const accentColor = tone === 'error' ? theme.error : tone === 'warn' ? theme.warning : theme.inactive;
  const bodyColor = tone === 'info' || tone === 'plain' ? theme.inactive : theme.statusText;
  const prefix = tone === 'plain' ? '' : tone === 'error' ? '◆' : tone === 'warn' ? '◇' : '◇';
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
