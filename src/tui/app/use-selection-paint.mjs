/**
 * use-selection-paint.mjs — publishing the ink-grid selection rect to the
 * renderer: the region clip + theme colours, the direct paint with deferred
 * text capture, and the motion-paint throttle (SELECTION_PAINT_INTERVAL_MS)
 * with its cancel/flush guards. The stitch harvest hooks in on every paint.
 */
import { useCallback, useEffect, useRef } from 'react';
import { selectionRectsEqual } from './transcript-window.mjs';
import { yieldToRenderer } from '../session/render-timing.mjs';
import {
  cancelPendingPaint,
  flushPendingPaint,
  publishSelectionRect,
  scheduleThrottledPaint,
} from './use-selection-paint/paint-queue.mjs';
import { clipSelectionRect, selectionClipBand } from './use-selection-paint/selection-clip.mjs';

export function useSelectionPaint({
  store,
  statuslineBandRows,
  dragRef,
  frameRowsRef,
  transcriptViewportRef,
  selectionTextRef,
  harvestStitchRowsSoon,
  clearStitchBuffer,
}) {
  const selectionPaintRef = useRef({ t: 0, rect: null, pending: null, timer: null });
  const selectionTextCaptureRef = useRef(0);

  useEffect(
    () => () => {
      const paintState = selectionPaintRef.current;
      if (paintState.timer) clearTimeout(paintState.timer);
      paintState.timer = null;
      paintState.pending = null;
      selectionTextCaptureRef.current += 1;
    },
    []
  );

  const rememberSelectionTextSoon = useCallback(() => {
    const capture = ++selectionTextCaptureRef.current;
    // setSelection publishes the rect synchronously, then Ink paints it through
    // the maxFps throttle. Read selectedText only after that frame's post-write
    // acknowledgement; a 0ms timer could beat a trailing render and capture the
    // previous rect. The generation guard makes the newest selection win.
    void yieldToRenderer().then(() => {
      if (capture !== selectionTextCaptureRef.current) return;
      const text = store.getRenderSelectionText?.();
      if (text?.trim()) selectionTextRef.current = text;
    });
  }, [store]);

  // Clip band + theming: use-selection-paint/selection-clip.mjs.
  const selectionClip = useCallback(
    () => selectionClipBand({ dragRef, frameRowsRef, transcriptViewportRef, statuslineBandRows }),
    []
  );

  const withSelectionClip = useCallback(
    (rect, options = {}) => (rect ? clipSelectionRect(rect, selectionClip(), options) : null),
    [selectionClip]
  );

  // Publish + throttle state machine: use-selection-paint/paint-queue.mjs.
  const paintSelectionRect = useCallback(
    (clippedRect, { rememberText = true } = {}) =>
      publishSelectionRect(selectionPaintRef, clippedRect, {
        store,
        rememberText,
        rememberSelectionTextSoon,
        harvestStitchRowsSoon,
      }),
    [store, rememberSelectionTextSoon, harvestStitchRowsSoon]
  );

  const cancelPendingSelectionPaint = useCallback(() => cancelPendingPaint(selectionPaintRef), []);

  const flushPendingSelectionPaint = useCallback(
    () => flushPendingPaint(selectionPaintRef, paintSelectionRect),
    [paintSelectionRect]
  );

  const applySelectionRect = useCallback(
    (rect) => {
      const clippedRect = withSelectionClip(rect);
      dragRef.current.rect = clippedRect || null;
      if (!clippedRect) {
        selectionTextCaptureRef.current += 1;
        selectionTextRef.current = '';
        clearStitchBuffer();
      }
      cancelPendingSelectionPaint();
      paintSelectionRect(clippedRect, { rememberText: true });
    },
    [paintSelectionRect, withSelectionClip, clearStitchBuffer, cancelPendingSelectionPaint]
  );

  const applySelectionRectThrottled = useCallback(
    (rect) => {
      const clippedRect = withSelectionClip(rect, { captureText: false });
      if (selectionRectsEqual(dragRef.current.rect, clippedRect)) return;
      dragRef.current.rect = clippedRect || null;
      scheduleThrottledPaint(selectionPaintRef, clippedRect, {
        paint: paintSelectionRect,
        cancelPending: cancelPendingSelectionPaint,
      });
    },
    [paintSelectionRect, withSelectionClip, cancelPendingSelectionPaint]
  );

  return {
    withSelectionClip,
    paintSelectionRect,
    cancelPendingSelectionPaint,
    flushPendingSelectionPaint,
    applySelectionRect,
    applySelectionRectThrottled,
  };
}
