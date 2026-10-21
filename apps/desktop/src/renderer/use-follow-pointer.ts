import { useCallback, useRef } from 'react';
import {
  distanceFromBottom,
  isTranscriptChromeTarget,
  POINTER_DRAG_PX,
  type PointerLike,
  pointerShouldReleaseFollow,
  scrollMetrics,
} from './transcript-follow-rules';

/** Pointer gestures on the transcript: scrollbar/chrome presses, and a
 *  selection drag that Chromium may autoscroll upward. */
export function useFollowPointer({
  markGesture,
  stop,
  lastTop,
}: {
  markGesture(): void;
  stop(reason?: string, previousTop?: number): void;
  lastTop: { current: number };
}) {
  const pointerGesture = useRef<{ x: number; y: number } | undefined>(undefined);
  const chromeScroll = useRef(false);
  // A content press is not a scroll gesture. A drag that has moved far enough
  // MAY become one if Chromium autoscrolls the transcript up.
  const pointerDragging = useRef(false);

  const handlePointerDown = useCallback(
    (event: PointerLike) => {
      const root = event.currentTarget;
      pointerDragging.current = false;
      chromeScroll.current = isTranscriptChromeTarget(root, event.target);
      if (chromeScroll.current) markGesture();
      pointerGesture.current =
        event.clientX === undefined || event.clientY === undefined ? undefined : { x: event.clientX, y: event.clientY };
    },
    [markGesture]
  );

  const handlePointerMove = useCallback(
    (event: PointerLike) => {
      if (event.buttons !== 1) return;
      const root = event.currentTarget;
      const start = pointerGesture.current;
      if (
        start &&
        event.clientX !== undefined &&
        event.clientY !== undefined &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) >= POINTER_DRAG_PX
      ) {
        pointerDragging.current = true;
        pointerGesture.current = undefined;
      }
      if (!pointerDragging.current) return;
      const metrics = scrollMetrics(root);
      if (
        !pointerShouldReleaseFollow({
          distance: distanceFromBottom(metrics),
          upwardMove: lastTop.current - metrics.top,
        })
      )
        return;
      markGesture();
      stop('selection', lastTop.current);
    },
    [lastTop, markGesture, stop]
  );

  /** The press is over (or reader ownership was handed back to the tail). */
  const reset = useCallback(() => {
    pointerDragging.current = false;
    pointerGesture.current = undefined;
    chromeScroll.current = false;
  }, []);

  const isChromePress = useCallback(() => chromeScroll.current, []);

  return { handlePointerDown, handlePointerMove, handlePointerUp: reset, reset, isChromePress };
}
