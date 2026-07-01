/**
 * Overprint a truncated right-side hint on the last row of a transcript item
 * without reserving an extra layout row (negative margin pulls the hint band up).
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';

function hintColor(tone) {
  if (tone === 'error') return theme.error;
  if (tone === 'warn' || tone === 'cancel') return theme.warning;
  if (tone === 'plain') return theme.subtle;
  return theme.inactive;
}

function cleanRightMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function ItemRightHintOverprint({
  children,
  rightMessage = '',
  rightTone = 'info',
  rightMessageWidth = 24,
}) {
  const rightText = cleanRightMessage(rightMessage);
  if (!rightText) return children;
  const rightWidth = Math.max(1, Number(rightMessageWidth) || 24);
  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      {children}
      <Box
        height={1}
        marginTop={-1}
        flexDirection="row"
        width="100%"
        flexShrink={0}
        overflow="hidden"
      >
        <Box flexGrow={1} flexShrink={1} overflow="hidden" />
        <Box
          flexShrink={0}
          width={rightWidth}
          marginLeft={1}
          marginRight={1}
          justifyContent="flex-end"
          overflow="hidden"
        >
          <Text color={hintColor(rightTone)} wrap="truncate">{rightText}</Text>
        </Box>
      </Box>
    </Box>
  );
}
