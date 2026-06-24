/**
 * components/TurnDone.jsx — the turn finished/cancelled line.
 *
 *   ◈ Thought for 12s
 *   ◈ Cancelled
 *
 * Pinned into the transcript right after a turn's output (an `item.kind ===
 * 'turndone'` entry), so it scrolls up with the answer and stays in the
 * scrollback — mirroring Claude Code's post-think summary line. It leaves a
 * quiet, dim record of how long the turn took next to the answer it belongs to.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';

export function TurnDone({ elapsedMs = 0, status = 'done' }) {
  const secs = Math.max(0, Math.round(elapsedMs / 1000));
  const cancelled = status === 'cancelled';

  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={theme.thinkingAccent}>◈ </Text>
      <Text color={theme.thinkingText}>{cancelled ? 'Cancelled' : `Thought for ${secs}s`}</Text>
    </Box>
  );
}
