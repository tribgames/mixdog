import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { isIOSWebSurface } from './mobile-surface';
import {
  type GestureScroller,
  IOS_TOUCH_SETTLE_MS,
  gestureScroller,
  scrollMetrics,
  scrollerTakes,
  touchScrollLatchOpen,
  touchTravelled,
  type TouchLike,
} from './transcript-follow-rules';
import type { FollowSignals } from './use-follow-signals';

/** A lifted finger keeps holding corrections this long: a fling it starts
 *  latches meanwhile, and a tap that only stopped a fling lands after it. */
const TOUCH_RELEASE_SETTLE_MS = 150;

/** The contacts a touch event started or ended (`changedTouches`). */
export type TouchContacts = { changedTouches: ArrayLike<{ identifier: number }> };

/** A touch keeps targeting its start element after it leaves the document, so
 *  its moves and end no longer bubble to the viewport; the target's own
 *  listeners forward them. */
function followDetachedTouch(
  event: TouchLike,
  onMove: (event: TouchLike) => void,
  onEnd: (event: TouchContacts) => void
): (() => void) | null {
  const target = event.target as (EventTarget & { isConnected?: boolean }) | null;
  const root = event.currentTarget;
  if (!target || target === root || typeof target.addEventListener !== 'function') return null;
  const move = (native: Event) => {
    if (target.isConnected !== false) return;
    onMove({ target, currentTarget: root, touches: (native as TouchEvent).touches });
  };
  const end = (native: Event) => {
    if (target.isConnected === false) onEnd({ changedTouches: (native as TouchEvent).changedTouches });
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
  const touchScroller = useRef<GestureScroller>(null);
  const touchLatched = useRef(false);
  // The identifiers of the contacts that started on the transcript: the page's
  // `touches` also lists fingers elsewhere (the composer), whose ends never
  // reach the transcript.
  const contacts = useRef(new Set<number>());
  const touchTarget = useRef<{ isConnected?: boolean } | null>(null);
  const detachedListeners = useRef(new Map<EventTarget, () => void>());
  const releaseDetached = useCallback(() => {
    for (const release of detachedListeners.current.values()) release();
    detachedListeners.current.clear();
  }, []);
  const touchScrollAt = useRef(0);
  // A touch whose row left the document stops owning the transcript even if
  // its end is lost; the next touch starts afresh.
  const fingerOnGlass = useCallback(() => contacts.current.size > 0 && touchTarget.current?.isConnected !== false, []);
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
    contacts.current.clear();
    releaseDetached();
    touchScrollAt.current = 0;
    touchEndedAt.current = 0;
  }, [releaseDetached]);

  const handleTouchMove = useCallback(
    (event: TouchLike) => {
      const point = event.touches[0];
      const next = point?.clientY;
      const previous = touchGesture.current;
      touchGesture.current = next;
      if (next === undefined || previous === undefined) return;
      const state = signals.current;
      const start = { x: state.touchStartX, y: state.touchStartY };
      const at = { x: point?.clientX ?? state.touchStartX, y: next };
      if (touchTravelled(start, at)) state.touchMoved = true;
      // A sideways swipe traverses panes; its vertical drift is no scroll of the transcript.
      if (Math.abs(at.x - start.x) > Math.abs(at.y - start.y)) return;
      const delta = previous - next;
      if (!delta) return;
      state.touchDragsUp = delta < 0;
      const transcriptReached = !scrollerTakes(touchScroller.current, delta);
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

  const handleTouchEnd = useCallback(
    (event: TouchContacts) => {
      let removed = false;
      for (const touch of Array.from(event.changedTouches)) {
        removed = contacts.current.delete(touch.identifier) || removed;
      }
      if (!removed) return;
      // The next move is measured afresh, never from the finger that lifted.
      touchGesture.current = undefined;
      // A transcript finger still down keeps owning it: the lift is judged
      // when the last one leaves.
      if (contacts.current.size > 0) return;
      releaseDetached();
      // The fling outlives the finger. The latch stays open; scrollend or the
      // idle fallback is what closes it.
      touchScrollAt.current = Date.now();
      touchEndedAt.current = touchScrollAt.current;
      onLift();
    },
    [onLift, releaseDetached]
  );

  const handleTouchStart = useCallback(
    (event: TouchLike & TouchContacts) => {
      touchGesture.current = event.touches[0]?.clientY;
      const state = signals.current;
      if (!fingerOnGlass()) {
        contacts.current.clear();
        releaseDetached();
        // The first finger down: what the lift is judged against.
        const root = viewport.current;
        state.touchStartTop = root ? scrollMetrics(root).top : 0;
        state.touchStartX = event.touches[0]?.clientX ?? 0;
        state.touchStartY = event.touches[0]?.clientY ?? 0;
        state.touchStartWriteAt = lastWriteAt();
        touchScroller.current = gestureScroller(event.currentTarget, event.target);
        state.touchMoved = false;
        state.touchDragsUp = false;
        state.touchScrolled = false;
        state.touchEndUpAt = 0;
        // A new touch stops any fling. A drag that could not move the
        // transcript (at an edge) gets no scrollend, so its latch would
        // otherwise reopen with every later tap's lift.
        touchLatched.current = false;
      }
      for (const touch of Array.from(event.changedTouches)) contacts.current.add(touch.identifier);
      touchTarget.current = event.target as { isConnected?: boolean } | null;
      touchScrollAt.current = Date.now();
      const target = event.target;
      if (target && !detachedListeners.current.has(target)) {
        const release = followDetachedTouch(event, handleTouchMove, handleTouchEnd);
        if (release) detachedListeners.current.set(target, release);
      }
    },
    [fingerOnGlass, handleTouchEnd, handleTouchMove, lastWriteAt, releaseDetached, signals, viewport]
  );
  useEffect(() => releaseDetached, [releaseDetached]);

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
