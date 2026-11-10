/**
 * Overprint a truncated right-side hint on the last row of a transcript item
 * without reserving an extra layout row (negative margin pulls the hint band up).
 */
import { Box, Text } from 'ink';
import { cleanRightMessage, promptStatusColor } from '../app/app-format.mjs';

// The right-aligned, truncated hint cell; also used inline by the turn-done
// rows. A plain function (not a component) so it adds no component boundary.
export function renderRightHint(rightText, rightMessageWidth, rightTone) {
  if (!rightText) return null;
  const rightWidth = Math.max(1, Number(rightMessageWidth) || 24);
  return (
    <Box flexShrink={0} width={rightWidth} marginLeft={1} marginRight={1} justifyContent="flex-end" overflow="hidden">
      <Text color={promptStatusColor(rightTone)} wrap="truncate">
        {rightText}
      </Text>
    </Box>
  );
}

export function ItemRightHintOverprint({ children, rightMessage = '', rightTone = 'info', rightMessageWidth = 24 }) {
  const rightText = cleanRightMessage(rightMessage);
  if (!rightText) return children;
  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      {children}
      <Box height={1} marginTop={-1} flexDirection="row" width="100%" flexShrink={0} overflow="hidden">
        <Box flexGrow={1} flexShrink={1} overflow="hidden" />
        {renderRightHint(rightText, rightMessageWidth, rightTone)}
      </Box>
    </Box>
  );
}
