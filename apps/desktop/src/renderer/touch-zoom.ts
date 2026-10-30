// Touch zoom gestures, read from touch events: a two-finger pinch, and on a
// picture surface also a one-finger pan and a double tap. One recognizer
// serves the image viewer (image-lightbox.tsx), the Visualize panel and its
// image panes (visualize-zoom.ts, VisualizePane.tsx) and the panel's inline
// frames (VisualizeInline.tsx); each applies the gestures to its own view.
//
// - Without `pan`, one finger is left alone (it keeps scrolling natively) and
//   only a pinch move is taken (preventDefault).
// - With `pan`, the surface owns every touch: its CSS sets `touch-action:
//   none`, so the browser never starts a scroll that would keep moving under
//   a pinch (once a scroll runs, the pinch's moves cannot be cancelled), and
//   one finger past the touch slop pans. The fingers' midpoint pans too while
//   they pinch, so the picture follows them.
// - A move an inner surface already took (defaultPrevented) is not taken
//   again by an outer one: an image pane pinches the panel once.
// - Mouse and pen never produce touch events: desktop input is untouched.
import { DOUBLE_TAP_TIMEOUT_MS, FIT_DOUBLE_TAP_SLOP_PX, TOUCH_SLOP_PX } from './remote-browser-touch';
import type { ZoomPoint } from './zoom-target';

type TouchPoint = { clientX: number; clientY: number };
type TouchList = { length: number; [index: number]: TouchPoint };

/** Two fingers' spread and midpoint, both in window CSS px. */
export function pinchGeometry(
  toWindow: (point: ZoomPoint) => ZoomPoint,
  first: TouchPoint,
  second: TouchPoint
): { spread: number; at: ZoomPoint } {
  const a = toWindow({ x: first.clientX, y: first.clientY });
  const b = toWindow({ x: second.clientX, y: second.clientY });
  return { spread: Math.hypot(a.x - b.x, a.y - b.y), at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

export interface TouchZoomHandlers {
  /** The fingers' spread grew by `ratio` since the last reported step; `at`
   *  is their midpoint (with `pan`, as it was before this move, the move
   *  following as a pan). Steps below 0.2% wait and add up. */
  pinch(ratio: number, at: ZoomPoint): void;
  /** One finger moved, or the pinching fingers' midpoint did, by (dx, dy). */
  pan?(dx: number, dy: number): void;
  /** A second tap close to the first, soon after it, at `at`. Its emulated
   *  mouse events (click, dblclick) are cancelled. */
  doubleTap?(at: ZoomPoint): void;
}

/** Watches `target` (an element, or a frame's document) for the gestures of
 *  `handlers`. Points are window CSS px, mapped by `toWindow` (a frame's own
 *  coordinates). Returns the cleanup. */
export function watchTouchZoom(
  target: EventTarget,
  handlers: TouchZoomHandlers,
  toWindow: (point: ZoomPoint) => ZoomPoint = (point) => point
): () => void {
  // Measured in window px: a frame drawn scaled by the zoom itself would
  // otherwise shrink the spread as the zoom grows, cancelling the pinch.
  let spread = 0;
  /** The fingers' midpoint (two), the finger (one), as of the last pan. */
  let center: ZoomPoint | null = null;
  /** Where the sequence's one finger went down while it may still be a tap. */
  let tapStart: ZoomPoint | null = null;
  let lastTap: { at: ZoomPoint; time: number } | null = null;
  const touchesOf = (event: Event) => (event as TouchEvent).touches as unknown as TouchList;
  const point = (touch: TouchPoint) => toWindow({ x: touch.clientX, y: touch.clientY });
  /** The baseline for the fingers now down. */
  const rebase = (touches: TouchList): void => {
    if (touches.length === 2) {
      const next = pinchGeometry(toWindow, touches[0], touches[1]);
      spread = next.spread;
      center = next.at;
    } else {
      spread = 0;
      center = touches.length === 1 ? point(touches[0]) : null;
    }
  };

  const onStart = (event: Event): void => {
    const touches = touchesOf(event);
    tapStart = touches.length === 1 ? point(touches[0]) : null;
    rebase(touches);
  };
  const onMove = (event: Event): void => {
    const touches = touchesOf(event);
    if (event.defaultPrevented) {
      tapStart = null;
      rebase(touches);
      return;
    }
    if (touches.length === 2 && spread > 0 && center) {
      event.preventDefault();
      tapStart = null;
      const next = pinchGeometry(toWindow, touches[0], touches[1]);
      if (next.spread <= 0) return;
      const ratio = next.spread / spread;
      const from = center;
      center = next.at;
      // With pan, the step is a zoom about where the midpoint was, then a
      // move by how far it went: the points under the fingers stay there.
      // Without, the browser keeps the content still and the zoom is about
      // the midpoint as it is now.
      if (Math.abs(ratio - 1) > 0.002) {
        spread = next.spread;
        handlers.pinch(ratio, handlers.pan ? from : next.at);
      }
      const shift = { x: next.at.x - from.x, y: next.at.y - from.y };
      if (handlers.pan && (shift.x || shift.y)) handlers.pan(shift.x, shift.y);
      return;
    }
    if (touches.length !== 1 || !handlers.pan || !center) return;
    if (event.cancelable) event.preventDefault();
    const at = point(touches[0]);
    // Within the slop the touch may still be a tap; past it, the pan starts
    // from where the finger went down, losing nothing.
    if (tapStart && Math.hypot(at.x - tapStart.x, at.y - tapStart.y) <= TOUCH_SLOP_PX) return;
    tapStart = null;
    handlers.pan(at.x - center.x, at.y - center.y);
    center = at;
  };
  const onEnd = (event: Event): void => {
    const touches = touchesOf(event);
    const lifted = (event as TouchEvent).changedTouches?.[0];
    if (touches.length === 0 && tapStart && lifted && handlers.doubleTap) {
      const at = point(lifted);
      const previous = lastTap;
      if (
        previous &&
        event.timeStamp - previous.time <= DOUBLE_TAP_TIMEOUT_MS &&
        Math.hypot(at.x - previous.at.x, at.y - previous.at.y) <= FIT_DOUBLE_TAP_SLOP_PX
      ) {
        lastTap = null;
        if (event.cancelable) event.preventDefault();
        handlers.doubleTap(at);
      } else {
        lastTap = { at, time: event.timeStamp };
      }
    } else if (touches.length === 0) {
      lastTap = null;
    }
    tapStart = null;
    rebase(touches);
  };
  const onCancel = (event: Event): void => {
    tapStart = null;
    lastTap = null;
    rebase(touchesOf(event));
  };
  target.addEventListener('touchstart', onStart, { passive: true });
  target.addEventListener('touchmove', onMove, { passive: false });
  target.addEventListener('touchend', onEnd, { passive: !handlers.doubleTap });
  target.addEventListener('touchcancel', onCancel, { passive: true });
  return () => {
    target.removeEventListener('touchstart', onStart);
    target.removeEventListener('touchmove', onMove);
    target.removeEventListener('touchend', onEnd);
    target.removeEventListener('touchcancel', onCancel);
  };
}
