/**
 * use-selection-focus.mjs — keyboard (Shift+Arrow / Home / End) movement of a
 * released ink-grid selection's focus end. At the transcript viewport edge an
 * Up/Down move scrolls one row to reveal new content (mirroring the mouse
 * edge-drag auto-scroll) instead of clamping the selection in place.
 */
import { useCallback } from 'react';

export function useSelectionFocusMove({
  dragRef,
  scrollTargetRef,
  transcriptBottomSlackRowsRef,
  statusBandRows,
  transcriptViewportRows,
  selectionMaxColAtRow,
  scrollTranscriptRows,
  applySelectionRect,
}) {
  // Scroll the transcript by deltaRows on behalf of an edge move. Returns null
  // when the scroll did not move; otherwise the anchor re-read from the
  // shifted rect (scrollTranscriptRows REPLACES dragRef.current with a shifted
  // copy, so the caller's `drag` binding is stale) or undefined when there is
  // no rect to re-read.
  const scrollFocusPastEdge = useCallback(
    (deltaRows) => {
      const beforeTarget = scrollTargetRef.current;
      scrollTranscriptRows(deltaRows);
      if (scrollTargetRef.current === beforeTarget) return null;
      const shiftedRect = dragRef.current.rect;
      return { anchor: shiftedRect ? { x: shiftedRect.x1, y: shiftedRect.y1 } : null };
    },
    [scrollTranscriptRows]
  );

  const moveSelectionFocus = useCallback(
    (move) => {
      const drag = dragRef.current;
      if (drag.active) return false;
      const region = drag.region;
      if (region !== 'transcript' && region !== 'status') return false;
      const rect = drag.rect;
      if (!rect) return false;
      if (rect.x1 === rect.x2 && rect.y1 === rect.y2) return false;

      let anchor = { x: rect.x1, y: rect.y1 };
      let col = rect.x2;
      let row = rect.y2;
      const beforeCol = col;
      const beforeRow = row;
      // Set when an edge move scrolled the transcript: row/col then numerically
      // equal their "before" values (both clamp to the same viewport edge
      // index) even though the underlying content changed, so the generic
      // before/after no-op guard below must not fire.
      let scrolledEdge = false;

      const { top, bottom } = region === 'status' ? statusBandRows() : transcriptViewportRows();
      const extendPastEdge = (deltaRows, edgeRow) => {
        const scrolled = scrollFocusPastEdge(deltaRows);
        if (!scrolled) return;
        scrolledEdge = true;
        if (scrolled.anchor) anchor = scrolled.anchor;
        row = edgeRow;
      };

      switch (move) {
        case 'left':
          if (col > 0) col -= 1;
          else if (row > top) {
            row -= 1;
            col = selectionMaxColAtRow(row);
          }
          break;
        case 'right': {
          const maxCol = selectionMaxColAtRow(row);
          if (col < maxCol) col += 1;
          else if (row < bottom) {
            row += 1;
            col = 0;
          }
          break;
        }
        case 'up':
          if (row > top) row -= 1;
          else if (region === 'transcript') {
            // Already at the top visible row: scroll up by one row (past the
            // bottom slack when still inside it) and extend the focus onto the
            // newly revealed top row.
            const beforeTarget = scrollTargetRef.current;
            const slack = Math.max(0, Number(transcriptBottomSlackRowsRef.current) || 0);
            extendPastEdge(beforeTarget <= slack ? slack + 1 - beforeTarget : 1, top);
          }
          break;
        case 'down':
          if (row < bottom) row += 1;
          else if (region === 'transcript') extendPastEdge(-1, bottom);
          break;
        case 'lineStart':
          col = 0;
          break;
        case 'lineEnd':
          col = selectionMaxColAtRow(row);
          break;
        default:
          return false;
      }

      row = Math.max(top, Math.min(bottom, row));
      col = Math.max(0, Math.min(selectionMaxColAtRow(row), col));

      if (!scrolledEdge && col === beforeCol && row === beforeRow) return false;

      // After an edge scroll dragRef.current is a NEW object; mutate the live
      // one, not the stale entry binding.
      const dragNow = dragRef.current;
      if (dragNow.anchorSpan) dragNow.anchorSpan = null;

      const focus = { x: col, y: row };
      applySelectionRect({
        mode: 'linear',
        x1: anchor.x,
        y1: anchor.y,
        x2: focus.x,
        y2: focus.y,
      });
      dragNow.last = { x: focus.x, y: focus.y };
      return true;
    },
    [applySelectionRect, statusBandRows, transcriptViewportRows, selectionMaxColAtRow, scrollFocusPastEdge]
  );

  return moveSelectionFocus;
}
