// use-selection-paint/paint-queue.mjs
// The paint state machine behind useSelectionPaint: publishing a rect to the
// renderer, and the motion throttle (SELECTION_PAINT_INTERVAL_MS) with its
// cancel/flush guards. Every helper takes the paint-state REF, so a pending
// timer reads the same live state the hook's callbacks do.
import { SELECTION_PAINT_INTERVAL_MS, selectionRectsEqual } from '../transcript-window.mjs';

/** Publishes `clippedRect` (or the null clear) and returns whether it painted. */
export function publishSelectionRect(
  stateRef,
  clippedRect,
  { store, rememberText, rememberSelectionTextSoon, harvestStitchRowsSoon }
) {
  const nextRect = clippedRect || null;
  const state = stateRef.current;
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
}

// Shared guard for EVERY direct (non-coalesced) paint path: a pending
// throttled repaint (state.timer/state.pending, armed by
// scheduleThrottledPaint) would fire AFTER a direct paint and stamp a stale
// pre-scroll/pre-direction rect over the current one — surfacing as two
// coexisting highlights. Cancel it before any direct paint.
export function cancelPendingPaint(stateRef) {
  const state = stateRef.current;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.pending = null;
}

// Publish an armed-but-unpainted coalesced rect NOW, so the throttled Ink
// render can consume the newest fast-drag rect. Paths that read the
// rendered selection (the pre-scroll stitch harvest) see the newest fast-drag
// rect rather than the previous rendered one. Cancel-only would drop the
// pending rect and lose rows it covered that scroll off before the rebuild.
export function flushPendingPaint(stateRef, paint) {
  const state = stateRef.current;
  if (!state.timer && !state.pending) return;
  const pending = state.pending;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.pending = null;
  if (pending) paint(pending, { rememberText: false });
}

/** Paints now when the interval has elapsed, otherwise arms the trailing timer. */
export function scheduleThrottledPaint(stateRef, clippedRect, { paint, cancelPending }) {
  const state = stateRef.current;
  if (selectionRectsEqual(state.rect, clippedRect)) return;
  const now = Date.now();
  const elapsed = now - state.t;
  if (elapsed >= SELECTION_PAINT_INTERVAL_MS) {
    cancelPending();
    paint(clippedRect, { rememberText: false });
    return;
  }
  state.pending = clippedRect || null;
  if (!state.timer) {
    state.timer = setTimeout(
      () => {
        const current = stateRef.current;
        const pending = current.pending;
        current.timer = null;
        current.pending = null;
        paint(pending, { rememberText: false });
      },
      Math.max(1, SELECTION_PAINT_INTERVAL_MS - elapsed)
    );
    state.timer.unref?.();
  }
}
