/**
 * components/TurnDone.jsx — the turn finished/cancelled line.
 *
 *   ◈ Thought for 12s / Reasoned for 12s / Mapped for 12s
 *   ◈ Cancelled
 *
 * Pinned into the transcript right after a turn's output (an `item.kind ===
 * 'turndone'` entry), so it scrolls up with the answer and stays in the
 * scrollback as a post-think summary line. It leaves a
 * quiet, dim record of how long the turn took next to the answer it belongs to.
 */
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';
import { formatDuration } from '../time-format.mjs';
import { TURN_DONE_MARKER } from '../figures.mjs';
import { cleanRightMessage } from '../app/app-format.mjs';
import { renderRightHint } from './ItemRightHintOverprint.jsx';

export function TurnDone({
  elapsedMs = 0,
  status = 'done',
  verb = 'Thought',
  toolCount = 0,
  rightMessage = '',
  rightTone = 'info',
  rightMessageWidth = 24,
  marginTop = 1,
}) {
  const elapsed = formatDuration(elapsedMs);
  const cancelled = status === 'cancelled';
  const doneVerb = String(verb || 'Thought').trim() || 'Thought';
  const elapsedNum = Math.max(0, Number(elapsedMs) || 0);
  const hasTools = Number(toolCount || 0) > 0;
  let copy;
  if (cancelled) {
    copy = elapsed ? `Cancelled after ${elapsed}` : 'Cancelled';
  } else if (hasTools) {
    copy = elapsed ? `Work complete in ${elapsed}` : 'Work complete';
  } else if (elapsedNum > 0 && elapsedNum < 10_000) {
    copy = 'Response complete';
  } else {
    copy = elapsed ? `${doneVerb} for ${elapsed}` : doneVerb;
  }
  const rightText = cleanRightMessage(rightMessage);

  return (
    <Box marginTop={marginTop} flexDirection="row" width="100%">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          <Text color={theme.spinnerGlyph}>{TURN_DONE_MARKER} </Text>
          <Text color={theme.thinkingAccent}>{copy}</Text>
        </Text>
      </Box>
      {renderRightHint(rightText, rightMessageWidth, rightTone)}
    </Box>
  );
}

export function StatusDone({
  label = 'Complete',
  detail = '',
  rightMessage = '',
  rightTone = 'info',
  rightMessageWidth = 24,
  marginTop = 1,
}) {
  const copy = String(label || 'Complete').trim() || 'Complete';
  const suffix = String(detail || '').trim();
  const rightText = cleanRightMessage(rightMessage);

  return (
    <Box marginTop={marginTop} flexDirection="row" width="100%">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          <Text color={theme.spinnerGlyph}>{TURN_DONE_MARKER} </Text>
          <Text color={theme.thinkingAccent}>{copy}</Text>
          {suffix ? <Text color={theme.subtle}> · {suffix}</Text> : null}
        </Text>
      </Box>
      {renderRightHint(rightText, rightMessageWidth, rightTone)}
    </Box>
  );
}
