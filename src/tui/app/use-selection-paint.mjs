/**
 * use-selection-paint.mjs — publishing the ink-grid selection rect to the
 * renderer: the region clip + theme colours, the direct paint with deferred
 * text capture, and the motion-paint throttle (SELECTION_PAINT_INTERVAL_MS)
 * with its cancel/flush guards. The stitch harvest hooks in on every paint.
 */
import { useCallback, useEffect, useRef } from 'react';
import { theme } from '../theme.mjs';
import { SELECTION_PAINT_INTERVAL_MS, selectionRectsEqual } from './transcript-window.mjs';
import { yieldToRenderer } from '../session/render-timing.mjs';

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

  const selectionClip = useCallback(() => {
    // The status-bar grid selection lives in the bottom statusline band, not the
    // transcript viewport — clip there so the highlight cannot spill into the
    // prompt/transcript rows. Everything else (transcript, word-select) keeps the
    // transcript-viewport clip.
    if (dragRef.current.region === 'status') {
      const rows = Math.max(1, Number(frameRowsRef.current) || 24);
      const top = Math.max(0, rows - statuslineBandRows);
      return { y1: top, y2: Math.max(top, rows - 1) };
    }
    return {
      y1: Math.max(0, Number(transcriptViewportRef.current?.top) || 0),
      y2: Math.max(0, Number(transcriptViewportRef.current?.bottom) || 0),
    };
  }, []);

  const withSelectionClip = useCallback(
    (rect, options = {}) => {
      if (!rect) return null;
      const clip = selectionClip();
      const clipped = {
        ...rect,
        clipY1: clip.y1,
        clipY2: Math.max(clip.y1, clip.y2),
        selectionForeground: theme.selectionHighlightText || theme.selectionText,
        selectionBackground: theme.selectionHighlightBackground || theme.selectionBackground,
      };
      if (options.captureText === false) clipped.captureText = false;
      return clipped;
    },
    [selectionClip]
  );

  const paintSelectionRect = useCallback(
    (clippedRect, { rememberText = true } = {}) => {
      const nextRect = clippedRect || null;
      const state = selectionPaintRef.current;
      if (selectionRectsEqual(state.rect, nextRect)) {
        const needsCapture = nextRect && rememberText && nextRect.captureText !== false;
        if (!needsCapture) return false;
        // Keep selection refreshes on Ink's normal maxFps render path. The
        // selection rect itself is published synchronously by setSelection.
        store.setRenderSelection?.(nextRect);
        rememberSelectionTextSoon();
        harvestStitchRowsSoon();
        return true;
      }
      state.rect = nextRect;
      state.t = Date.now();
      store.setRenderSelection?.(nextRect);
      if (nextRect && rememberText && nextRect.captureText !== false) rememberSelectionTextSoon();
      if (nextRect) harvestStitchRowsSoon();
      return true;
    },
    [store, rememberSelectionTextSoon, harvestStitchRowsSoon]
  );

  // Shared guard for EVERY direct (non-coalesced) paint path: a pending
  // throttled repaint (state.timer/state.pending, armed by
  // applySelectionRectThrottled) would fire AFTER a direct paint and stamp a
  // stale pre-scroll/pre-direction rect over the current one — surfacing as two
  // coexisting highlights. Cancel it before any direct paint.
  const cancelPendingSelectionPaint = useCallback(() => {
    const state = selectionPaintRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.pending = null;
  }, []);

  // Publish an armed-but-unpainted coalesced rect NOW, so the throttled Ink
  // render can consume the newest fast-drag rect. Paths that read the
  // rendered selection (the pre-scroll stitch harvest) see the newest fast-drag
  // rect rather than the previous rendered one. Cancel-only would drop the
  // pending rect and lose rows it covered that scroll off before the rebuild.
  const flushPendingSelectionPaint = useCallback(() => {
    const state = selectionPaintRef.current;
    if (!state.timer && !state.pending) return;
    const pending = state.pending;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.pending = null;
    if (pending) paintSelectionRect(pending, { rememberText: false });
  }, [paintSelectionRect]);

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
      const state = selectionPaintRef.current;
      if (selectionRectsEqual(state.rect, clippedRect)) return;
      const now = Date.now();
      const elapsed = now - state.t;
      if (elapsed >= SELECTION_PAINT_INTERVAL_MS) {
        cancelPendingSelectionPaint();
        paintSelectionRect(clippedRect, { rememberText: false });
        return;
      }
      state.pending = clippedRect || null;
      if (!state.timer) {
        state.timer = setTimeout(
          () => {
            const current = selectionPaintRef.current;
            const pending = current.pending;
            current.timer = null;
            current.pending = null;
            paintSelectionRect(pending, { rememberText: false });
          },
          Math.max(1, SELECTION_PAINT_INTERVAL_MS - elapsed)
        );
        state.timer.unref?.();
      }
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
