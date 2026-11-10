// use-selection-paint/selection-clip.mjs
// Where a selection rect is allowed to paint, and the theme colours it carries
// to the renderer.
import { theme } from '../../theme.mjs';
import { statusBandRowRange, transcriptViewportRowRange } from '../transcript-window.mjs';

/**
 * The row band of the region being dragged. The status-bar grid selection
 * lives in the bottom statusline band, not the transcript viewport — clip
 * there so the highlight cannot spill into the prompt/transcript rows.
 * Everything else (transcript, word-select) keeps the transcript-viewport clip.
 */
export function selectionClipBand({ dragRef, frameRowsRef, transcriptViewportRef, statuslineBandRows }) {
  const band =
    dragRef.current.region === 'status'
      ? statusBandRowRange(frameRowsRef.current, statuslineBandRows)
      : transcriptViewportRowRange(transcriptViewportRef.current);
  return { y1: band.top, y2: band.bottom };
}

/** The rect as the renderer takes it: clipped to `clip` and themed. */
export function clipSelectionRect(rect, clip, options = {}) {
  if (!rect) return null;
  const clipped = {
    ...rect,
    clipY1: clip.y1,
    clipY2: Math.max(clip.y1, clip.y2),
    selectionForeground: theme.selectionHighlightText || theme.selectionText,
    selectionBackground: theme.selectionHighlightBackground || theme.selectionBackground,
  };
  if (options.captureText === false) clipped.captureText = false;
  return clipped;
}
