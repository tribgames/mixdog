/**
 * use-selection-geometry.mjs — cell/row geometry of the ink-grid selection:
 * scroll re-anchoring of stored points, word/line span extension, the
 * transcript-viewport and status-band row ranges, the rightmost selectable
 * column of a row, and the synchronous "is a grid selection live" predicate.
 */
import { useCallback, useRef } from 'react';
import { compareCellOrder } from './transcript-window.mjs';

export function useSelectionGeometry({
  store,
  frameColumns,
  statuslineBandRows,
  scrollTargetRef,
  frameRowsRef,
  transcriptViewportRef,
  dragRef,
}) {
  const selectionPointAtCurrentScroll = useCallback((point, pointScroll = 0) => {
    if (!point) return null;
    return {
      x: point.x,
      y: point.y + (Number(scrollTargetRef.current) || 0) - (Number(pointScroll) || 0),
    };
  }, []);

  // Grow a word/line multi-click selection from its anchor span out to the
  // word/line under the cursor. Shared by the mouse handler (motion/release)
  // AND the auto-scroll path so both rebuild a span-aware rect. The moving end
  // snaps to the word or line under the cursor and falls back to the raw cell
  // on a miss; spanScroll re-anchors the stored span to the current transcript
  // scroll (the status band never scrolls) so the original word keeps tracking
  // its content while dragging or auto-scrolling.
  const buildSpanRect = useCallback(
    (span, x, y, region, spanScroll = 0) => {
      const atCurrentScroll = (point) =>
        region === 'status' ? point : selectionPointAtCurrentScroll(point, spanScroll);
      const anchorStart = atCurrentScroll(span.lo);
      const anchorEnd = atCurrentScroll(span.hi);

      const snapped = span.kind === 'word' ? store.getWordRectAt?.(x, y) : store.getLineRectAt?.(y);
      let targetStart;
      let targetEnd;
      if (snapped) {
        targetStart = { x: snapped.x1, y: snapped.y1 };
        targetEnd = { x: snapped.x2, y: snapped.y2 };
      } else if (span.kind === 'word') {
        targetStart = { x, y };
        targetEnd = { x, y };
      } else {
        targetStart = { x: 0, y };
        targetEnd = { x: Math.max(0, frameColumns - 1), y };
      }

      // The anchor span always stays whole; the rect reaches from it toward the
      // target when the target sits clear of it on either side, and collapses
      // back to the anchor when the two overlap.
      const linear = (from, to) => ({ mode: 'linear', x1: from.x, y1: from.y, x2: to.x, y2: to.y });
      if (compareCellOrder(targetEnd, anchorStart) < 0) return linear(anchorEnd, targetStart);
      if (compareCellOrder(targetStart, anchorEnd) > 0) return linear(anchorStart, targetEnd);
      return linear(anchorStart, anchorEnd);
    },
    [store, frameColumns, selectionPointAtCurrentScroll]
  );

  const transcriptViewportRows = useCallback(() => {
    const top = Math.max(0, Number(transcriptViewportRef.current?.top) || 0);
    const bottom = Math.max(top, Number(transcriptViewportRef.current?.bottom) || top);
    return { top, bottom };
  }, []);

  const statusBandRows = useCallback(() => {
    const rows = Math.max(1, Number(frameRowsRef.current) || 24);
    const top = Math.max(0, rows - statuslineBandRows);
    return { top, bottom: Math.max(top, rows - 1) };
  }, []);

  const selectionMaxColAtRow = useCallback(
    (row) => {
      const lr = store.getLineRectAt?.(row);
      if (lr != null && Number.isFinite(lr.x2)) return Math.max(0, lr.x2);
      return Math.max(0, frameColumns - 1);
    },
    [store, frameColumns]
  );

  // Synchronous predicate: is a transcript/status ink-grid selection live? Used
  // both by App (to consume Shift+Arrow even when focus clamps at an edge) and
  // by PromptInput (via prop) to gate its own Shift+Arrow at event time — a
  // flag set inside App's parent handler would be one event stale (parent
  // handler runs AFTER the child prompt handler for the same key).
  const gridSelectionActiveRef = useRef(() => {
    const drag = dragRef.current;
    if (!drag || drag.active) return false;
    if (drag.region !== 'transcript' && drag.region !== 'status') return false;
    const rect = drag.rect;
    return Boolean(rect) && !(rect.x1 === rect.x2 && rect.y1 === rect.y2);
  });

  return {
    selectionPointAtCurrentScroll,
    buildSpanRect,
    transcriptViewportRows,
    statusBandRows,
    selectionMaxColAtRow,
    gridSelectionActiveRef,
  };
}
