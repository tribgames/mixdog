/**
 * components/ContextPanel.jsx - read-only context usage dashboard.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';

function truncateText(value, width) {
  const text = String(value || '');
  if (!(width > 0)) return '';
  if (text.length <= width) return text;
  return width <= 1 ? '…'.repeat(Math.max(0, width)) : `${text.slice(0, Math.max(1, width - 1))}…`;
}

export function ContextPanel({ rows, title = 'Context Usage', columns = 80, fillHeight = false }) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const labelWidth = Math.min(
    safeRows.reduce((w, row) => Math.max(w, String(row.label || '').length), 0),
    Math.max(12, Math.floor(columns * 0.24)),
  );
  const valueWidth = Math.max(0, columns - labelWidth - 8);

  return (
    <Box flexDirection="column" flexShrink={0} width="100%" height={fillHeight ? '100%' : undefined}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.promptBorder}
        paddingX={1}
        width="100%"
        height={fillHeight ? '100%' : undefined}
      >
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text color={theme.panelTitle}>{title}</Text>
          <Text color={theme.subtle}>Esc back</Text>
        </Box>
        {safeRows.map((row) => (
          <Box key={row.value || row.label} flexDirection="row" width="100%">
            <Text color={theme.inactive}>{truncateText(row.label, labelWidth).padEnd(labelWidth)}</Text>
            <Text color={theme.text}>
              {'  '}
              {truncateText(row.description, valueWidth)}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
