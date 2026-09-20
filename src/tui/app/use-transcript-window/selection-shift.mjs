/**
 * selection-shift.mjs — keep a released mouse selection glued to its text
 * while the transcript geometry underneath it moves or the theme repaints.
 */
import { useEffect, useLayoutEffect } from 'react';
import { shiftSelectionRectY } from '../transcript-window.mjs';

export function useSelectionLayoutShift({
  transcriptWindow,
  transcriptContentHeight,
  themeEpoch,
  transcriptViewportRef,
  selectionLayoutRef,
  dragRef,
  withSelectionClip,
  paintSelectionRect,
}) {
  useLayoutEffect(() => {
    const top = Math.max(0, Number(transcriptViewportRef.current?.top) || 0);
    const next = {
      top,
      height: Math.max(1, Number(transcriptContentHeight) || 1),
      totalRows: Math.max(0, Number(transcriptWindow.totalRows) || 0),
      scrollOffset: Math.max(0, Number(transcriptWindow.effectiveScrollOffset) || 0),
    };
    const previous = selectionLayoutRef.current;
    selectionLayoutRef.current = next;
    if (!previous || !dragRef.current.rect || dragRef.current.active) return;
    const deltaY =
      next.top -
      previous.top +
      (next.height - previous.height) -
      (next.totalRows - previous.totalRows) +
      (next.scrollOffset - previous.scrollOffset);
    if (deltaY === 0) return;
    const clippedRect = withSelectionClip(shiftSelectionRectY(dragRef.current.rect, deltaY));
    dragRef.current = { ...dragRef.current, rect: clippedRect };
    // rememberText:false — the shifted rect is viewport-clipped, so harvesting
    // here would replace the full selection text remembered at drag-release
    // with only the still-visible fragment (partial Ctrl+C after scrolling).
    paintSelectionRect(clippedRect, { rememberText: false, immediate: true });
  }, [
    transcriptContentHeight,
    transcriptWindow.totalRows,
    transcriptWindow.effectiveScrollOffset,
    withSelectionClip,
    paintSelectionRect,
  ]);
  useEffect(() => {
    if (!dragRef.current.rect) return;
    const clippedRect = withSelectionClip(dragRef.current.rect);
    dragRef.current = { ...dragRef.current, rect: clippedRect };
    // Theme repaint: same cells, same text — no need to re-harvest (and a
    // clipped rect would clobber the remembered full text with a fragment).
    paintSelectionRect(clippedRect, { rememberText: false, immediate: true });
  }, [themeEpoch, withSelectionClip, paintSelectionRect]);
}
