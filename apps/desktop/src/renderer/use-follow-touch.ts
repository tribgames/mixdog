import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { isIOSWebSurface } from './mobile-surface';
import {
  boundaryGestureReached,
  boundaryTarget,
  IOS_TOUCH_SETTLE_MS,
  touchMoveShouldReleaseFollow,
  touchScrollLatchOpen,
  type TouchLike,
} from './transcript-follow-rules';

/** A lifted finger keeps holding corrections this long: a fling it starts
 *  latches meanwhile, and a tap that only stopped a fling lands after it. */
const TOUCH_RELEASE_SETTLE_MS = 150;

/** A touch keeps targeting the element it started on after that element
 *  leaves the document, and its moves and end then never bubble to the
 *  viewport. A streamed word's fade wrapper is unwrapped the moment its fade
 *  ends: a drag that began on the newest words of a live reply went unseen,
 *  follow was never released, and the end pin wrote the tail back under the
 *  finger every frame (phone: scrolling up stopped at once). The target's own
 *  listeners hand such events to the viewport's handlers; while the target is
 *  still in the document they bubble there themselves. */
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
  stop,
  lastTop,
  wheelScrolling,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  markGesture(): void;
  stop(reason?: string, previousTop?: number): void;
  lastTop: RefObject<number>;
  wheelScrolling(): boolean;
}) {
  const touchGesture = useRef<number | undefined>(undefined);
  const touchLatched = useRef(false);
  const touchDown = useRef(false);
  // A touch keeps targeting the element it started on. When virtualization
  // unmounts that row mid-drag, its touchend never reaches the viewport, and
  // "finger down" stayed true until the NEXT touch: every row size deferred
  // for reader motion then stayed deferred and the geometry never recovered.
  // A detached target ends the finger's ownership; the scroll-idle fallback
  // still owns the fling.
  const touchTarget = useRef<{ isConnected?: boolean } | null>(null);
  // The moves and end of a touch whose target left the document (see
  // followDetachedTouch); removes the target's listeners.
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
  // A touch scroll holds measured-size corrections and page landings off the
  // native offset until its fling is over, on every engine. On an Android
  // phone a scrollTop write under a touch fling desyncs the fling from the
  // page: the fling stops short, and the next touch reconciles the two
  // offsets in one jump (Android: 위로 빠르게 넘기면 멈추고, 다시 터치하면 훨씬
  // 위로 순간이동). Headless Chromium keeps flinging through such a write, so
  // only a device shows it. Chromium's fling ends at scrollend (or the idle
  // fallback); iOS WebKit fires no reliable end, so its hold ends once the
  // scroll has been quiet for a moment. A touch hold lands early at the top
  // edge, so a fling toward older history never sticks at native 0 short of
  // a page that landed above it (transcript-list-touch-deviation).
  // A finger on the glass holds too, scrolling or not, and so does one lifted
  // a moment ago: landing in the gap between the fling's stop and the next
  // touch is the jump itself, and a lifted finger may still start a fling.
  const [iosWebKit] = useState(isIOSWebSurface);
  const touchEndedAt = useRef(0);
  const touchHoldsCorrections = useCallback(
    () =>
      fingerOnGlass() ||
      Date.now() - touchEndedAt.current < TOUCH_RELEASE_SETTLE_MS ||
      touchScrollLatchOpen({
        latched: touchLatched.current,
        touchDown: false,
        sinceScrollMs: Date.now() - touchScrollAt.current,
        idleMs: iosWebKit ? IOS_TOUCH_SETTLE_MS : undefined,
      }),
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
        // Wheel intent releases synchronously before Chromium's first scroll
        // frame; touch must do the same. Keeping the end anchor alive until the
        // later scroll event lets row measurement and followOnAppend reverse the
        // finger's movement, producing the mobile up/down scrollbar shake.
        if (touchMoveShouldReleaseFollow({ delta, transcriptReached })) {
          stop('touch', lastTop.current);
        }
      }
    },
    [lastTop, markGesture, stop]
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
  }, []);

  const handleTouchStart = useCallback(
    (event: TouchLike) => {
      touchGesture.current = event.touches[0]?.clientY;
      touchDown.current = true;
      touchTarget.current = event.target as { isConnected?: boolean } | null;
      touchScrollAt.current = Date.now();
      releaseTouchTarget.current?.();
      releaseTouchTarget.current = followDetachedTouch(event, handleTouchMove, handleTouchEnd);
    },
    [handleTouchEnd, handleTouchMove]
  );
  useEffect(
    () => () => {
      releaseTouchTarget.current?.();
      releaseTouchTarget.current = null;
    },
    []
  );

  // Chromium — Android included — reports the true end of a touch scroll,
  // momentum and all, with scrollend. It is the only precise "native motion is
  // over" signal available, so it closes the touch latch directly instead of
  // waiting out the idle fallback.
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
