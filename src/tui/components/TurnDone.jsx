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
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';
import { formatDuration } from '../time-format.mjs';
import { TURN_DONE_MARKER } from '../figures.mjs';

function statusMessageColor(tone) {
  if (tone === 'error') return theme.error;
  if (tone === 'warn' || tone === 'cancel') return theme.warning;
  if (tone === 'plain') return theme.subtle;
  return theme.inactive;
}

function cleanRightMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function TurnDone({ elapsedMs = 0, status = 'done', verb = 'Thought', rightMessage = '', rightTone = 'info', rightMessageWidth = 24, marginTop = 1 }) {
  const elapsed = formatDuration(elapsedMs);
  const cancelled = status === 'cancelled';
  const doneVerb = String(verb || 'Thought').trim() || 'Thought';
  const copy = cancelled
    ? elapsed ? `Cancelled after ${elapsed}` : 'Cancelled'
    : elapsed ? `${doneVerb} for ${elapsed}` : doneVerb;
  const rightText = cleanRightMessage(rightMessage);
  const rightWidth = Math.max(1, Number(rightMessageWidth) || 24);

  return (
    <Box marginTop={marginTop} flexDirection="row" width="100%">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          <Text color={theme.spinnerGlyph}>{TURN_DONE_MARKER} </Text>
          <Text color={theme.thinkingAccent}>{copy}</Text>
        </Text>
      </Box>
      {rightText ? (
        <Box flexShrink={0} width={rightWidth} marginLeft={1} marginRight={1} justifyContent="flex-end" overflow="hidden">
          <Text color={statusMessageColor(rightTone)} wrap="truncate">{rightText}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function StatusDone({ label = 'Complete', detail = '', rightMessage = '', rightTone = 'info', rightMessageWidth = 24, marginTop = 1 }) {
  const copy = String(label || 'Complete').trim() || 'Complete';
  const suffix = String(detail || '').trim();
  const rightText = cleanRightMessage(rightMessage);
  const rightWidth = Math.max(1, Number(rightMessageWidth) || 24);

  return (
    <Box marginTop={marginTop} flexDirection="row" width="100%">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          <Text color={theme.spinnerGlyph}>{TURN_DONE_MARKER} </Text>
          <Text color={theme.thinkingAccent}>{copy}</Text>
          {suffix ? <Text color={theme.subtle}> · {suffix}</Text> : null}
        </Text>
      </Box>
      {rightText ? (
        <Box flexShrink={0} width={rightWidth} marginLeft={1} marginRight={1} justifyContent="flex-end" overflow="hidden">
          <Text color={statusMessageColor(rightTone)} wrap="truncate">{rightText}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
