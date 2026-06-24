/**
 * components/TurnDone.jsx — the "reasoning finished" line.
 *
 *   ✻ Thought for 12s
 *
 * Shown once a turn completes (the spinner is gone). Without it the spinner just
 * vanishes and the screen feels empty — this leaves a quiet, dim record of how
 * long the turn took, mirroring Claude Code's post-think summary line.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';

function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function TurnDone({ elapsedMs = 0, tokens = 0 }) {
  const secs = Math.max(0, Math.round(elapsedMs / 1000));
  const tokenCount = Math.max(0, Math.round(Number(tokens || 0)));

  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={theme.text}>✻ </Text>
      <Text color={theme.inactive}>
        Thought for {secs}s{tokenCount > 0 ? ` · ${formatNumber(tokenCount)} tokens` : ''}
      </Text>
    </Box>
  );
}
