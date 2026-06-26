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
  // background, 2-col gutter), but stays readable while it waits to be sent.
  // Explicit numeric width guarantees the band fills the row.
  // One cell short of the edge: writing the last terminal column triggers
  // Windows auto-wrap/scroll that drifts the alt-screen frame (see UserMessage).
  const bandColumns = Math.max(1, columns - 1);
  return (
    <Box marginTop={1} flexDirection="column">
      {queued.map((item) => {
        // Truncate to 1 line so the row reservation (queued.length in App.jsx)
        // stays accurate — wrapped text would push the input box off-screen.
        // Content width = bandColumns(columns-1) - paddingLeft(2) - paddingRight(1)
        // = columns-4. When truncating we append '…' (1 cell), so the slice
        // must leave room for that suffix and avoid a wrap to row 2.
        const contentWidth = Math.max(1, columns - 4);
        const sourceText = String(item.displayText || item.text || '');
        const displayText = sourceText.length > contentWidth
          ? (contentWidth <= 1 ? '…'.repeat(contentWidth) : sourceText.slice(0, Math.max(1, contentWidth - 1)) + '…')
          : sourceText;
        return (
          <Box key={item.id} width={bandColumns} backgroundColor={theme.userMessageBackground} paddingLeft={2} paddingRight={1}>
            <Text wrap="wrap">
              <Text color={theme.mixdogIvory}>{displayText}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
