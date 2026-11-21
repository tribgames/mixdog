import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { isIOSWebSurface } from './mobile-surface';
import {
  boundaryGestureReached,
  boundaryTarget,
  IOS_TOUCH_SETTLE_MS,
  scrollMetrics,
  touchScrollLatchOpen,
  touchTravelled,
  type TouchLike,
} from './transcript-follow-rules';
import type { FollowSignals } from './use-follow-signals';

/** A lifted finger keeps holding corrections this long: a fling it starts
 *  latches meanwhile, and a tap that only stopped a fling lands after it. */
const TOUCH_RELEASE_SETTLE_MS = 150;

/** A touch keeps targeting its start element after it leaves the document, so
 *  its moves and end no longer bubble to the viewport; the target's own
 *  listeners forward them. */
function followDetachedTouch(
  event: TouchLike,
  onMove: (event: TouchLike) => void,
  onEnd: () => void
): (() => void) | null {
  const target = event.target as (EventTarget & { isConnected?: boolean }) | null;
  const root = event.currentTarget;
  if (!target || target === root || typeof target.addEventListener !== 'function') return null;
  const move = (native: Event) => {
    if (target.isConnected !== false) return;
    onMove({ target, currentTarget: root, touches: (native as TouchEvent).touches });
  };
  const end = () => {
    if (target.isConnected === false) onEnd();
  };
  target.addEventListener('touchmove', move, { passive: true });
  target.addEventListener('touchend', end, { passive: true });
  target.addEventListener('touchcancel', end, { passive: true });
  return () => {
    target.removeEventListener('touchmove', move);
    target.removeEventListener('touchend', end);
    target.removeEventListener('touchcancel', end);
  };
}

/** Touch scroll ownership: armed by a drag that actually moves the
 *  transcript, held for as long as the finger is down, and closed by
 *  scrollend (or the idle fallback) once the fling is over. */
export function useFollowTouch({
  viewport,
  markGesture,
  wheelScrolling,
  signals,
  lastWriteAt,
  onLift,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  markGesture(): void;
  wheelScrolling(): boolean;
  signals: RefObject<FollowSignals>;
  /** When the timeline last wrote the offset. */
  lastWriteAt(): number;
  /** Every finger is up: judge the scroll the touch ended. */
  onLift(): void;
}) {
  const touchGesture = useRef<number | undefined>(undefined);
  const touchLatched = useRef(false);
  const touchDown = useRef(false);
  const touchTarget = useRef<{ isConnected?: boolean } | null>(null);
  const releaseTouchTarget = useRef<(() => void) | null>(null);
  const touchScrollAt = useRef(0);
  const fingerOnGlass = useCallback(() => {
    if (!touchDown.current) return false;
    if (touchTarget.current?.isConnected === false) {
      touchDown.current = false;
      return false;
    }
    return true;
  }, []);
  const hasTouchScroll = useCallback(
    () =>
      touchScrollLatchOpen({
        latched: touchLatched.current,
        touchDown: fingerOnGlass(),
        sinceScrollMs: Date.now() - touchScrollAt.current,
      }),
    [fingerOnGlass]
  );
  // iOS WebKit only: a scrollTop write cancels touch-fling momentum and WebKit
  // fires no reliable fling end, so corrections are held until the scroll has
  // been quiet. Chromium keeps momentum through a write.
  const [iosWebKit] = useState(isIOSWebSurface);
  const touchEndedAt = useRef(0);
  const touchHoldsCorrections = useCallback(
    () =>
      iosWebKit &&
      (fingerOnGlass() ||
        Date.now() - touchEndedAt.current < TOUCH_RELEASE_SETTLE_MS ||
        touchScrollLatchOpen({
          latched: touchLatched.current,
          touchDown: false,
          sinceScrollMs: Date.now() - touchScrollAt.current,
          idleMs: IOS_TOUCH_SETTLE_MS,
        })),
    [fingerOnGlass, iosWebKit]
  );
  const holdsScrollCorrections = useCallback(
    () => wheelScrolling() || touchHoldsCorrections(),
    [touchHoldsCorrections, wheelScrolling]
  );

  /** Every frame of a touch scroll — finger-driven or inertial — keeps the
   *  latch alive, so the idle fallback can only close it once the native
   *  stream has actually stopped delivering. */
  const noteScroll = useCallback(() => {
    if (touchLatched.current) touchScrollAt.current = Date.now();
  }, []);

  /** Reader ownership ends the instant the reader asks for the tail. */
  const reset = useCallback(() => {
    touchGesture.current = undefined;
    touchLatched.current = false;
    touchDown.current = false;
    touchScrollAt.current = 0;
    touchEndedAt.current = 0;
  }, []);

  const handleTouchMove = useCallback(
    (event: TouchLike) => {
      const next = event.touches[0]?.clientY;
      const previous = touchGesture.current;
      touchGesture.current = next;
      if (next === undefined || previous === undefined) return;
      if (touchTravelled(signals.current.touchStartY, next)) signals.current.touchMoved = true;
      const delta = previous - next;
      if (!delta) return;
      const target = boundaryTarget(event.currentTarget, event.target);
      const transcriptReached = target === event.currentTarget || boundaryGestureReached(target, delta);
      if (transcriptReached) {
        markGesture();
        // This drag is moving the transcript itself: ownership now belongs to
        // the touch, not to a window that expires while the phone is busy.
        touchLatched.current = true;
        touchScrollAt.current = Date.now();
      }
    },
    [markGesture, signals]
  );

  const handleTouchEnd = useCallback(() => {
    releaseTouchTarget.current?.();
    releaseTouchTarget.current = null;
    touchGesture.current = undefined;
    touchDown.current = false;
    // The fling outlives the finger. The latch stays open; scrollend or the
    // idle fallback is what closes it.
    touchScrollAt.current = Date.now();
    touchEndedAt.current = touchScrollAt.current;
    onLift();
  }, [onLift]);

  const handleTouchStart = useCallback(
    (event: TouchLike) => {
      touchGesture.current = event.touches[0]?.clientY;
      const state = signals.current;
      if (!touchDown.current) {
        // The first finger down: what the lift is judged against.
        const root = viewport.current;
        state.touchStartTop = root ? scrollMetrics(root).top : 0;
        state.touchStartY = event.touches[0]?.clientY ?? 0;
        state.touchStartWriteAt = lastWriteAt();
        state.touchMoved = false;
        state.touchScrolled = false;
        state.touchEndUpAt = 0;
        state.mutationAt = Number.NEGATIVE_INFINITY;
      }
      touchDown.current = true;
      touchTarget.current = event.target as { isConnected?: boolean } | null;
      touchScrollAt.current = Date.now();
      releaseTouchTarget.current?.();
      releaseTouchTarget.current = followDetachedTouch(event, handleTouchMove, handleTouchEnd);
    },
    [handleTouchEnd, handleTouchMove, lastWriteAt, signals, viewport]
  );
  useEffect(
    () => () => {
      releaseTouchTarget.current?.();
      releaseTouchTarget.current = null;
    },
    []
  );

  // Chromium reports the true end of a touch scroll, momentum included, with scrollend.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const closeLatch = () => {
      if (fingerOnGlass()) return;
      touchLatched.current = false;
    };
    element.addEventListener('scrollend', closeLatch);
    return () => element.removeEventListener('scrollend', closeLatch);
  }, [fingerOnGlass, viewport]);

  return {
    fingerOnGlass,
    hasTouchScroll,
    holdsScrollCorrections,
    touchHoldsCorrections,
    noteScroll,
    reset,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
