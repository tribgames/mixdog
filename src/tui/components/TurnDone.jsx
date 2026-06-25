/**
 * components/TurnDone.jsx — the turn finished/cancelled line.
 *
 *   ◈ Thought for 12s / Reasoned for 12s / Mapped for 12s
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
import { formatDuration } from '../time-format.mjs';

export function TurnDone({ elapsedMs = 0, status = 'done', verb = 'Thought' }) {
  const elapsed = formatDuration(elapsedMs);
  const cancelled = status === 'cancelled';
  const doneVerb = String(verb || 'Thought').trim() || 'Thought';

  return (
    <Box marginTop={1} flexDirection="row">
      <Text>
        <Text color={theme.spinnerGlyph}>* </Text>
        <Text color={theme.thinkingAccent}>{cancelled ? `Cancelled after ${elapsed}` : `${doneVerb} for ${elapsed}`}</Text>
      </Text>
    </Box>
  );
}
