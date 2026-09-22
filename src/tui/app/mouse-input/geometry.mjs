/**
 * mouse-input/geometry.mjs — region geometry for the SGR mouse handler.
 *
 * One responsibility: decide which surface owns an absolute grid cell
 * (transcript viewport, statusline band, prompt box) and snap drag points into
 * that surface. Every helper resolves the CURRENT rects from the injected refs
 * at call time, so the bundle can be built once per input-effect subscription
 * (see use-mouse-input.mjs).
 */
import { statusBandRowRange, transcriptViewportRowRange } from '../transcript-window.mjs';

export function linearSelection(a, b) {
  return {
    mode: 'linear',
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
  };
}

export function createMouseGeometry({
  transcriptViewportRef,
  frameRowsRef,
  statuslineBandRows,
  frameColumns,
  stdout,
  promptBoxRectRef,
  promptMouseSelectionRef,
}) {
  const transcriptViewport = () => transcriptViewportRowRange(transcriptViewportRef.current);
  const isInTranscriptViewport = (row) => {
    const { top, bottom } = transcriptViewport();
    return row >= top && row <= bottom;
  };
  const clampToTranscriptViewport = (row) => {
    const { top, bottom } = transcriptViewport();
    return Math.max(top, Math.min(bottom, row));
  };
  // [mixdog] Status-bar band = the bottom statuslineBandRows rows. The
  // prompt box occupies the rows reported by PromptInput's measured rect.
  const statusBand = () => statusBandRowRange(frameRowsRef.current, statuslineBandRows);
  const isInStatusBand = (row) => {
    const { top, bottom } = statusBand();
    return row >= top && row <= bottom;
  };
  const clampToStatusBand = (row) => {
    const { top, bottom } = statusBand();
    return Math.max(top, Math.min(bottom, row));
  };
  const maxSelectionColumn = () => {
    const cols = Math.max(1, Number(frameColumns) || Number(stdout?.columns) || 80);
    return cols - 1;
  };
  // Snap a drag point into the region that owns the selection. Rows clamp to
  // the band as before, but the COLUMN now follows normal text-selection
  // semantics: a pointer ABOVE the band selects to the start of its first
  // row, BELOW it to the end of its last row — instead of freezing at
  // whatever column the pointer happened to hold, which painted a partial row
  // on the wrong side of the anchor. Horizontal overshoot is clamped into the
  // grid too: while the pointer sits outside the window a terminal can report
  // column 0 (x = -1 after the 1-based fixup) or a column past the width, and
  // that point orders BEFORE/AFTER the anchor and visibly flips the selection.
  const selectionPointInRegion = (x, y, region) => {
    const { top, bottom } = region === 'status' ? statusBand() : transcriptViewport();
    const maxX = maxSelectionColumn();
    if (y < top) return { x: 0, y: top };
    if (y > bottom) return { x: maxX, y: bottom };
    return { x: Math.max(0, Math.min(maxX, x)), y };
  };
  const promptRect = () => promptBoxRectRef.current;
  const isInPromptBox = (x, y) => {
    const r = promptRect();
    if (!r) return false;
    const top = Math.max(0, Number(r.top) || 0);
    const bottom = top + Math.max(1, Number(r.height) || 1) - 1;
    const left = Math.max(0, Number(r.left) || 0);
    const width = Math.max(1, Number(r.contentWidth) || 1);
    return y >= top && y <= bottom && x >= left && x < left + width;
  };
  // Map an absolute grid cell to a prompt-draft edit offset via PromptInput's
  // measured box rect + its caret math (offsetAtCell handles wrapping).
  const promptOffsetAt = (x, y) => {
    const r = promptRect();
    const ctl = promptMouseSelectionRef.current;
    if (!r || !ctl) return null;
    const top = Math.max(0, Number(r.top) || 0);
    const left = Math.max(0, Number(r.left) || 0);
    const height = Math.max(1, Number(r.height) || 1);
    const width = Math.max(1, Number(r.contentWidth) || 1);
    // Clamp the mapped row/col to the box's own bounds so a drag that runs
    // outside the prompt (above/below/left/right, e.g. onto the transcript
    // or off-screen) still tracks the nearest edge cell instead of jumping
    // to whatever offset a raw negative/overflowing row would resolve to.
    const row = Math.max(0, Math.min(height - 1, y - top));
    const col = Math.max(0, Math.min(width, x - left));
    return ctl.offsetAtCell(row, col);
  };
  return {
    transcriptViewport,
    isInTranscriptViewport,
    clampToTranscriptViewport,
    isInStatusBand,
    clampToStatusBand,
    selectionPointInRegion,
    isInPromptBox,
    promptOffsetAt,
  };
}
