/**
 * app-view/transcript-viewport/trailing-bands.jsx — the fixed rows that trail
 * the scrolled transcript column: the welcome prompt hint, the panel-close
 * mask, the overlay hint band and the transcript guard band. Each one renders
 * null when its row budget is 0, so the viewport keeps its exact height.
 */
import { Box, Text } from 'ink';
import { theme, surfaceBackground } from '../../../theme.mjs';
import { centerLine, promptStatusColor } from '../../app-format.mjs';

/** The right-aligned hint cell shared by the overlay band, the guard band and
 *  the prompt meta row (app-view.jsx). */
export function hintCell({ inputHint, inputHintTone, width }) {
  return (
    <Box flexShrink={0} width={width || 1} marginLeft={1} marginRight={1} justifyContent="flex-end" overflow="hidden">
      <Text color={promptStatusColor(inputHintTone)} wrap="truncate">
        {inputHint}
      </Text>
    </Box>
  );
}

export function renderWelcomeHintRow({ welcomePromptHintRows, welcomePromptHintText, frameColumns }) {
  if (!(welcomePromptHintRows > 0)) return null;
  return (
    <Box height={1} flexShrink={0} width="100%" overflow="hidden">
      <Text color={theme.inactive} wrap="truncate">
        {centerLine(welcomePromptHintText, frameColumns, 2)}
      </Text>
    </Box>
  );
}

export function renderPanelCloseMask({ panelCloseMaskRows }) {
  if (!(panelCloseMaskRows > 0)) return null;
  return (
    <Box
      height={panelCloseMaskRows}
      flexShrink={0}
      width="100%"
      overflow="hidden"
      backgroundColor={surfaceBackground()}
    />
  );
}

export function renderOverlayHintBand({ overlayHintBandRows, inputHint, inputHintTone, guardHintWidth }) {
  if (!(overlayHintBandRows > 0)) return null;
  return (
    <Box
      height={1}
      flexShrink={0}
      backgroundColor={surfaceBackground()}
      flexDirection="row"
      width="100%"
      overflow="hidden"
    >
      <Box flexGrow={1} flexShrink={1} overflow="hidden" />
      {hintCell({ inputHint, inputHintTone, width: guardHintWidth })}
    </Box>
  );
}

export function renderTranscriptGuardBand({
  transcriptGuardRows,
  overlayHintFallbackRow,
  overlayHintBandRows,
  inputHint,
  inputHintTone,
  guardHintWidth,
}) {
  if (!(transcriptGuardRows > 0)) return null;
  return (
    <Box
      height={transcriptGuardRows}
      flexShrink={0}
      backgroundColor={surfaceBackground()}
      flexDirection="row"
      width="100%"
      overflow="hidden"
    >
      <Box flexGrow={1} flexShrink={1} overflow="hidden" />
      {overlayHintFallbackRow && overlayHintBandRows === 0
        ? hintCell({ inputHint, inputHintTone, width: guardHintWidth })
        : null}
    </Box>
  );
}
