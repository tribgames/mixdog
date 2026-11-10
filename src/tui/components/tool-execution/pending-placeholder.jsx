/*
 * components/tool-execution/pending-placeholder.jsx — blank card reserved for a
 * freshly started tool still inside its pending-show delay.
 */
import { Box, Text } from 'ink';
import { formatToolSurface } from '../../../runtime/shared/tool-surface.mjs';
import { SKILL_SURFACE_NAMES, isAgentTool } from './surface-detail.mjs';

export function renderPendingPlaceholder(card) {
  const { name, args, aggregate, attached, rowWidth } = card;
  // Mirror estimateTranscriptItemRows: a non-aggregate skill surface collapses
  // to a single header row; everything else reserves header + one detail row.
  const placeholderNormalizedName = String(formatToolSurface(name, args)?.normalizedName || '').toLowerCase();
  // Skill AND agent surfaces collapse to a single header row when collapsed
  // (see estimateTranscriptItemRows); reserve one row for both.
  const placeholderSingleRow =
    !aggregate && (SKILL_SURFACE_NAMES.has(placeholderNormalizedName) || isAgentTool(placeholderNormalizedName));
  return (
    <Box flexDirection="column" marginTop={attached ? 0 : 1} width={rowWidth} overflow="hidden">
      <Text> </Text>
      {placeholderSingleRow ? null : <Text> </Text>}
    </Box>
  );
}
