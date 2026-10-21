import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';
import {
  GESTURE_WINDOW_MS,
  READER_SCROLL_IDLE_MS,
  SCROLL_KEYS,
  selectionAutoScrollShouldReleaseFollow,
  wheelShouldReleaseFollow,
  boundaryGestureReached,
  reportRelease,
  type WheelLike,
  type PointerLike,
  type TouchLike,
  normalizeWheelDelta,
  boundaryTarget,
  scrollMetrics,
  distanceFromBottom,
  canScroll,
} from './transcript-follow-rules';
import { useFollowContentObserver } from './use-follow-content-observer';
import { useJumpButtonState, useJumpPin } from './use-follow-jump';
import { useFollowPointer } from './use-follow-pointer';
import { useProgrammaticWrites } from './use-follow-programmatic';
import { useFollowScrollEvent, useScrollBaselines, useSettledReattach } from './use-follow-scroll';
import { useFollowTouch } from './use-follow-touch';
export {
  registerTranscriptScrollGeometry,
  transcriptScrollExtent,
  transcriptScrollPosition,
} from './transcript-follow-rules';
export {
  TRANSCRIPT_OVERFLOW_ANCHOR,
  grewWhileAtBottom,
  pointerShouldReleaseFollow,
  selectionAutoScrollShouldReleaseFollow,
  readerScrollShouldReleaseFollow,
  touchMoveShouldReleaseFollow,
  touchScrollLatchOpen,
  wheelShouldReleaseFollow,
  boundaryGestureReached,
  programmaticWriteMatches,
  transcriptScrollGeometryRegistered,
} from './transcript-follow-rules';

/**
 * Transcript auto-scroll + session scroll-gesture grammar.
 *
 * The hook owns userScrolled, the 250ms gesture window, re-attaching at the
 * content end once the reader's scroll settles, and the content
 * ResizeObserver. TranscriptList owns EVERY scroll write:
 * virtual row geometry, append following, and measured-size anchoring.
 * This hook asks for scrollToEnd only when follow resumes. The timeline owns
 * viewport resizing as well as row geometry.
 */
interface TranscriptFollow {
  following: boolean;
  followingRef: RefObject<boolean>;
  showJump: boolean;
  hasScrollGesture(): boolean;
  /** A touch drag that moved the transcript, from finger down through its fling. */
  hasTouchScroll(): boolean;
  /** A wheel scroll through its native ramp, or a touch scroll through its
   *  fling: the list holds measured-size corrections off scrollTop until it
   *  ends. */
  holdsScrollCorrections(): boolean;
  /** The touch half of holdsScrollCorrections: such a hold lands early at
   *  the top edge (a wheel ramp's holds until the ramp ends). */
  touchHoldsCorrections(): boolean;
  handleScroll(): void;
  handleWheel(event: WheelLike): void;
  handlePointerDown(event: PointerLike): void;
  handlePointerMove(event: PointerLike): void;
  handlePointerUp(): void;
  handleSelectionAutoScroll(delta: number): void;
  handleTouchStart(event: TouchLike): void;
  handleTouchMove(event: TouchLike): void;
  handleTouchEnd(): void;
  handleInteraction(): void;
  handleKeyDown(event: { key: string }): void;
  pause(): void;
  resume(): void;
  arm(): void;
  /** Reported by the virtual timeline for every offset IT writes. */
  markProgrammaticScroll(top: number, intended?: number): void;
}

export function useTranscriptFollow({
  viewport,
  content,
  sessionKey,
  contentMounted = true,
  setAnchorBottomRef,
  scrollToEndRef,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  sessionKey: string;
  /** The timeline mounts only once its rows can be rendered for real, so the
   *  content observer has to re-attach when that mount finally happens. */
  contentMounted?: boolean;
  /** Flips the virtual timeline's bottom anchor in the SAME task as the
   *  reader's intent. React state reaches the timeline a render later, and the
   *  core's end anchor rolls back every frame it still owns — a wheel notch
   *  inside the core's end band was reversed before the release could land. */
  setAnchorBottomRef?: MutableRefObject<(bottom: boolean) => void>;
  /** Bottom correction requests cross this boundary; the hook never writes
   *  scrollTop itself. TranscriptList resolves them through virtual-core. */
  scrollToEndRef?: MutableRefObject<(behavior?: ScrollBehavior) => void>;
}): TranscriptFollow {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const gestureAt = useRef(0);
  const readerMotionAt = useRef(0);
  // A wheel that reached the transcript, and the last scroll of its ramp.
  const wheelAt = useRef(0);
  const wheelMotionAt = useRef(0);
  const { lastTop, lastNativeTop, lastScrollHeight, lastDistance, reseedBaselines } = useScrollBaselines();
  const { markProgrammaticScroll, isProgrammatic, forgetWrites } = useProgrammaticWrites();
  const { showJump, scheduleScrollState } = useJumpButtonState();
  const { cancelJumpPin, startJumpPin } = useJumpPin({ viewport, followingRef, scrollToEndRef });
  const publish = useCallback(
    (next: boolean) => {
      followingRef.current = next;
      // The timeline anchor is part of the same decision, not a consequence of
      // the re-render that follows it.
      setAnchorBottomRef?.current?.(next);
      setFollowing((current) => (current === next ? current : next));
    },
    [setAnchorBottomRef]
  );

  /** The jump owns the viewport only until the reader asks for it back. */
  const markGesture = useCallback(() => {
    cancelJumpPin();
    const now = Date.now();
    gestureAt.current = now;
    readerMotionAt.current = now;
  }, [cancelJumpPin]);

  const hasGesture = useCallback(() => Date.now() - gestureAt.current < GESTURE_WINDOW_MS, []);
  // A scrollTop write while Chromium animates a wheel scroll cancels the
  // animation: every row measured into view while scrolling up (its estimate
  // corrected) cut the wheel's ramp short, and the transcript caught on each
  // one (휠 스크롤이 턱턱 걸림). Like a touch fling, the ramp holds those
  // corrections as a row offset until its scroll events go quiet.
  const wheelScrolling = useCallback(() => {
    const wheel = wheelAt.current;
    if (!wheel) return false;
    if (Date.now() - Math.max(wheel, wheelMotionAt.current) < GESTURE_WINDOW_MS) return true;
    wheelAt.current = 0;
    return false;
  }, []);
  const markReaderMotion = useCallback(() => {
    const now = Date.now();
    readerMotionAt.current = now;
    if (wheelScrolling()) wheelMotionAt.current = now;
  }, [wheelScrolling]);
  const scrollToBottom = useCallback(
    (force: boolean) => {
      const element = viewport.current;
      if (!element) return;
      if (force && !followingRef.current) publish(true);
      if (!force && !followingRef.current) return;
      const metrics = scrollMetrics(element);
      if (distanceFromBottom(metrics) < 2) return;
      if (transcriptScrollDiagnosticsEnabled()) {
        logTranscriptScroll('follow-request', {
          force,
          top: metrics.top,
          distance: distanceFromBottom(metrics),
        });
      }
      scrollToEndRef?.current?.('auto');
    },
    [publish, scrollToEndRef, viewport]
  );

  const stop = useCallback(
    (reason = 'gesture', previousTop = 0) => {
      const element = viewport.current;
      if (!element) return;
      const metrics = scrollMetrics(element);
      if (!canScroll(metrics)) {
        publish(true);
        return;
      }
      if (!followingRef.current) return;
      reportRelease(reason, metrics, previousTop);
      publish(false);
    },
    [publish, viewport]
  );

  const pause = useCallback(() => stop('pause'), [stop]);

  const {
    fingerOnGlass,
    hasTouchScroll,
    holdsScrollCorrections,
    touchHoldsCorrections,
    noteScroll,
    reset: resetTouch,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useFollowTouch({ viewport, markGesture, stop, lastTop, wheelScrolling });
  const {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    reset: resetPointer,
    isChromePress,
  } = useFollowPointer({ markGesture, stop, lastTop });

  /** Reader ownership ends the instant the reader asks for the tail. */
  const clearReaderGesture = useCallback(() => {
    gestureAt.current = 0;
    readerMotionAt.current = 0;
    wheelAt.current = 0;
    resetTouch();
    resetPointer();
  }, [resetPointer, resetTouch]);
  // A finger on the glass owns the viewport before its first touchmove is
  // handled. On a phone the compositor scrolls from the first move past the
  // slop while the main thread is still busy with a streaming frame; the end
  // pin that frame requested then wrote the old bottom back under the finger
  // and every small upward drag juddered until the touchmove released follow.
  // A pin requested meanwhile waits for the finger (the end pin retries every
  // frame), so a tap that never scrolls still lands on the new bottom.
  const hasReaderScroll = useCallback(
    () =>
      hasGesture() ||
      hasTouchScroll() ||
      fingerOnGlass() ||
      Date.now() - readerMotionAt.current < READER_SCROLL_IDLE_MS,
    [fingerOnGlass, hasGesture, hasTouchScroll]
  );
  // The reader's scroll is over: no gesture, motion, fling, or touch hold.
  const readerSettled = useCallback(
    () => !hasReaderScroll() && !holdsScrollCorrections(),
    [hasReaderScroll, holdsScrollCorrections]
  );
  const readerScrolling = useCallback(() => !readerSettled(), [readerSettled]);
  const { noteReaderPosition, cancelReattach } = useSettledReattach({ followingRef, readerSettled, publish });
  // Session switch: the viewport element survives while the timeline remounts
  // for the new session. Offsets, distances, and programmatic writes from the
  // previous session must not judge the new session's first frames — a stale
  // baseline made the entry scroll read as a reader leave (or a return) and
  // the transcript visibly jumped on every tab switch. Never writes scrollTop:
  // the virtual timeline owns the entry position.
  const resetSessionKey = useRef(sessionKey);
  useEffect(() => {
    if (resetSessionKey.current === sessionKey) return;
    resetSessionKey.current = sessionKey;
    cancelJumpPin();
    cancelReattach();
    forgetWrites();
    clearReaderGesture();
    reseedBaselines(viewport.current);
  }, [cancelJumpPin, cancelReattach, clearReaderGesture, forgetWrites, reseedBaselines, sessionKey, viewport]);
  const handleScroll = useFollowScrollEvent({
    viewport,
    followingRef,
    lastTop,
    lastNativeTop,
    lastScrollHeight,
    lastDistance,
    scheduleScrollState,
    noteScroll,
    isProgrammatic,
    isChromePress,
    fingerOnGlass,
    hasReaderScroll,
    markReaderMotion,
    noteReaderPosition,
    stop,
  });

  const handleWheel = useCallback(
    (event: WheelLike) => {
      const root = event.currentTarget;
      const delta = normalizeWheelDelta(event);
      if (!delta) return;
      const target = boundaryTarget(root, event.target);
      // One boundary decision drives BOTH marks. Testing "is there any nested
      // scroller?" separately kept follow armed for an upward wheel at a nested
      // scroller's leading edge: the gesture was marked, the transcript scrolled
      // up by chaining, and the end anchor then fought the reader every frame.
      const transcriptReached = target === root || boundaryGestureReached(target, delta);
      if (!transcriptReached) return;
      markGesture();
      wheelAt.current = Date.now();
      wheelMotionAt.current = 0;
      // Wheel rule: an upward wheel is explicit intent
      // and releases immediately, however small it is. Re-attaching is the side
      // that carries the slack (reattachBand).
      if (wheelShouldReleaseFollow({ delta, transcriptReached })) {
        stop('wheel', lastTop.current);
      }
    },
    [lastTop, markGesture, stop]
  );

  const handleSelectionAutoScroll = useCallback(
    (delta: number) => {
      if (!Number.isFinite(delta) || delta === 0) return;
      // Claim reader ownership before TranscriptList writes scrollTop so the
      // virtual end anchor cannot pull against that write in the same frame.
      markGesture();
      if (selectionAutoScrollShouldReleaseFollow(delta)) {
        stop('selection', lastTop.current);
      }
    },
    [lastTop, markGesture, stop]
  );

  const handleInteraction = useCallback(() => {
    // Click and in-place selection are not scroll intent. Releasing here
    // unlocked wrap/follow whenever the reader copied a live script line.
  }, []);

  const handleKeyDown = useCallback(
    (event: { key: string; target?: EventTarget | null; currentTarget?: HTMLDivElement }) => {
      if (!SCROLL_KEYS.includes(event.key)) return;
      const root = event.currentTarget ?? viewport.current;
      if (!root || boundaryTarget(root, event.target ?? root) !== root) return;
      markGesture();
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        stop('key', lastTop.current);
      }
    },
    [lastTop, markGesture, stop, viewport]
  );

  const resume = useCallback(() => {
    cancelJumpPin();
    // Before any write: the timeline refuses every end write while a gesture
    // window is open, so the jump has to close that window itself.
    clearReaderGesture();
    publish(true);
    scrollToBottom(true);
    startJumpPin();
    const element = viewport.current;
    if (element) scheduleScrollState(element);
  }, [cancelJumpPin, clearReaderGesture, publish, scheduleScrollState, scrollToBottom, startJumpPin, viewport]);
  // Session ENTRY only re-arms following; it must not write scrollTop. The
  // virtual timeline already resolves its end position (initialOffset +
  // scrollToEnd), and a raw `scrollTop = scrollHeight` here made entry carry
  // TWO scroll authorities aiming at different offsets — the multi-frame
  // jump/flicker on re-entering a session.
  const arm = useCallback(() => {
    // A pin from the previous session must not write into the new one.
    cancelJumpPin();
    // Entry and submit explicitly return ownership to the tail. Keeping the
    // previous wheel/drag window open made the timeline reject the append's
    // only bottom pin, leaving the new prompt below the viewport.
    clearReaderGesture();
    publish(true);
    const element = viewport.current;
    if (element) scheduleScrollState(element);
  }, [cancelJumpPin, clearReaderGesture, publish, scheduleScrollState, viewport]);

  useFollowContentObserver({
    viewport,
    content,
    contentMounted,
    sessionKey,
    following,
    followingRef,
    lastScrollHeight,
    lastDistance,
    readerScrolling,
    isProgrammatic,
    publish,
    scheduleScrollState,
    scrollToBottom,
  });
  return {
    following,
    followingRef,
    showJump,
    hasScrollGesture: hasReaderScroll,
    hasTouchScroll,
    holdsScrollCorrections,
    touchHoldsCorrections,
    handleScroll,
    handleWheel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleSelectionAutoScroll,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleInteraction,
    handleKeyDown,
    pause,
    resume,
    arm,
    markProgrammaticScroll,
  };
}
