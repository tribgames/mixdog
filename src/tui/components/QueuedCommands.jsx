/**
 * components/QueuedCommands.jsx — queued steering prompts.
 *
 * Queued steering prompts: lines the user typed
 * while a turn is busy wait here as dim rows, pinned just above the input box
 * (part of the input cluster) instead of polluting the transcript. Each queued
 * line is promoted to a real transcript user row only when it starts executing
 * (see engine drain()).
 *
 * Default (expanded) mode renders the FULL wrapped text at the same content
 * width the promoted transcript user row uses, so promotion does not change
 * the row height mid-flight (the old 1-line truncation made the frame visibly
 * jump when a wrapped message expanded on promotion). App.jsx reserves the
 * matching height via queuedBandRows() and flips `compact` on when the queue
 * would not fit the frame — compact mode truncates each entry to one row.
 *
 * Renders nothing when the queue is empty.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';

export function QueuedCommands({ queued, columns, compact = false }) {
  if (!queued || queued.length === 0) return null;
  // Each queued line reads as a full-width band like a user message (same
  // background, 2-col gutter), but stays readable while it waits to be sent.
  // Explicit numeric width guarantees the band fills the row.
  // One cell short of the edge: writing the last terminal column triggers
  // Windows auto-wrap/scroll that drifts the alt-screen frame (see UserMessage).
  const bandColumns = Math.max(1, columns - 1);
  // Content width = bandColumns(columns-1) - paddingLeft(2) - paddingRight(1)
  // = columns-4. Compact truncation appends '…' (1 cell), so the slice must
  // leave room for that suffix and avoid a wrap to row 2.
  const contentWidth = Math.max(1, columns - 4);
  return (
    <Box flexDirection="column">
      {queued.map((item) => {
        const sourceText = String(item.displayText || item.text || '');
        let displayText = sourceText;
        if (compact) {
          // Compact fallback: exactly 1 row per entry (queued.length reserve).
          // Collapse newlines first — a raw '\n' would still break the row.
          const oneLine = sourceText.replace(/\r?\n/g, ' ');
          displayText = oneLine.length > contentWidth
            ? (contentWidth <= 1 ? '…'.repeat(contentWidth) : oneLine.slice(0, Math.max(1, contentWidth - 1)) + '…')
            : oneLine;
        }
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
