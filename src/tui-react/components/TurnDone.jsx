/**
 * components/TurnDone.jsx — the "reasoning finished" line.
 *
 *   ✻ Thought for 12s · 621 tokens
 *
 * Shown once a turn completes (the spinner is gone). Without it the spinner just
 * vanishes and the screen feels empty — this leaves a quiet, dim record of how
 * long the turn took, mirroring Claude Code's post-think summary line.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';

export function TurnDone({ elapsedMs = 0, tokens = 0 }) {
  const secs = Math.max(0, Math.round(elapsedMs / 1000));
  const meta = [`Thought for ${secs}s`, tokens > 0 ? `${tokens} tokens` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={theme.text}>✻ </Text>
      <Text color={theme.inactive}>{meta}</Text>
    </Box>
  );
}
