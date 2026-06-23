/**
 * components/QueuedCommands.jsx — queued steering prompts.
 *
 * Forked from Claude Code's PromptInputQueuedCommands: lines the user typed
 * while a turn is busy wait here as dim rows, pinned just above the input box
 * (part of the input cluster) instead of polluting the transcript. Each queued
 * line is promoted to a real transcript user row only when it starts executing
 * (see engine drain()).
 *
 * Renders nothing when the queue is empty.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';

export function QueuedCommands({ queued, columns }) {
  if (!queued || queued.length === 0) return null;
  // Each queued line reads as a full-width band like a user message (same
  // background, 2-col gutter), but dimmed text marks it as "waiting, not sent".
  // Explicit numeric width guarantees the band fills the row.
  return (
    <Box marginTop={1} flexDirection="column">
      {queued.map((item) => (
        <Box key={item.id} width={columns} backgroundColor={theme.userMessageBackground} paddingLeft={2} paddingRight={1}>
          <Text color={theme.inactive} wrap="wrap">{item.text}</Text>
        </Box>
      ))}
    </Box>
  );
}
