/**
 * app-view/transcript-viewport.jsx — the scrolling transcript surface.
 *
 * One responsibility: the BOUNDED, fixed-height clipping box that holds the
 * windowed transcript items plus the rows that trail it (welcome prompt hint,
 * panel-close mask, overlay hint band, transcript guard band). The explicit
 * numeric height + overflow:hidden is what lets ink actually slice the
 * off-screen rows (output.clip in render-node-to-output.js), so older rows can
 * never overprint newer ones. justifyContent flex-end keeps the newest content
 * pinned to the bottom edge; older content overflows the TOP and is clipped.
 * flexShrink lets it yield rows to the live status / a multi-line input rather
 * than overflow the screen. app-view.jsx owns the frame around it.
 *
 * The scrolled item column lives in transcript-viewport/transcript-rows.jsx and
 * the fixed rows below it in transcript-viewport/trailing-bands.jsx.
 */
import { Box } from 'ink';
import { renderTranscriptRows } from './transcript-viewport/transcript-rows.jsx';
import {
  renderOverlayHintBand,
  renderPanelCloseMask,
  renderTranscriptGuardBand,
  renderWelcomeHintRow,
} from './transcript-viewport/trailing-bands.jsx';

export function renderTranscriptViewport(ctx) {
  const {
    frameColumns,
    guardHintWidth,
    inputHint,
    inputHintTone,
    overlayHintBandRows,
    overlayHintFallbackRow,
    panelCloseMaskRows,
    transcriptContentHeight,
    transcriptGuardRows,
    viewportHeight,
    welcomePromptHintRows,
    welcomePromptHintText,
  } = ctx;
  return (
    <Box
      flexDirection="column"
      width="100%"
      height={viewportHeight}
      flexGrow={0}
      flexShrink={1}
      overflow="hidden"
      justifyContent="flex-end"
    >
      <Box
        flexDirection="column"
        width="100%"
        height={transcriptContentHeight}
        flexShrink={0}
        overflow="hidden"
        justifyContent="flex-end"
      >
        {renderTranscriptRows(ctx)}
      </Box>
      {renderWelcomeHintRow({ welcomePromptHintRows, welcomePromptHintText, frameColumns })}
      {renderPanelCloseMask({ panelCloseMaskRows })}
      {renderOverlayHintBand({ overlayHintBandRows, inputHint, inputHintTone, guardHintWidth })}
      {renderTranscriptGuardBand({
        transcriptGuardRows,
        overlayHintFallbackRow,
        overlayHintBandRows,
        inputHint,
        inputHintTone,
        guardHintWidth,
      })}
    </Box>
  );
}
