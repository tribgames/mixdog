import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';
import {
  GESTURE_WINDOW_MS,
  READER_SCROLL_IDLE_MS,
  activationReleasesFollow,
  classifyScrollKey,
  editableTarget,
  keyUpRecent,
  liftLeftAboveEnd,
  touchLiftNeedsJudgement,
  wheelIsVerticalScroll,
  wheelReleasesFollow,
  boundaryGestureReached,
  reportRelease,
  type WheelLike,
  type PointerLike,
  type TouchLike,
  normalizeWheelDelta,
  boundaryTarget,
  scrollMetrics,
  distanceFromBottom,
} from './transcript-follow-rules';
import { useFollowContentObserver } from './use-follow-content-observer';
import { useJumpButtonState, useJumpPin } from './use-follow-jump';
import { useProgrammaticWrites } from './use-follow-programmatic';
import { useFollowScrollJudge, useScrollBaselines } from './use-follow-scroll';
import { useFollowSignals } from './use-follow-signals';
import { useFollowTouch } from './use-follow-touch';
export {
  registerTranscriptScrollGeometry,
  transcriptScrollExtent,
  transcriptScrollPosition,
} from './transcript-follow-rules';
export {
  TRANSCRIPT_OVERFLOW_ANCHOR,
  activationReleasesFollow,
  attributeWrite,
  chromePressHeld,
  classifyScrollKey,
  jumpButtonVisible,
  judgeScrollEvent,
  touchScrollLatchOpen,
  wheelReleasesFollow,
  boundaryGestureReached,
  transcriptScrollGeometryRegistered,
} from './transcript-follow-rules';

interface TranscriptFollow {
  following: boolean;
  followingRef: RefObject<boolean>;
  showJump: boolean;
  hasScrollGesture(): boolean;
  /** A touch drag that moved the transcript, from finger down through its fling. */
  hasTouchScroll(): boolean;
  /** A wheel scroll through its native ramp, or (iOS WebKit only) a touch
   *  scroll through its fling: the list holds measured-size corrections off
   *  scrollTop until it ends. */
  holdsScrollCorrections(): boolean;
  /** The touch half of holdsScrollCorrections: such a hold lands early once
   *  the logical offset reaches the real top (a wheel ramp's holds until the
   *  ramp ends). */
  touchHoldsCorrections(): boolean;
  handleScroll(): void;
  handleWheel(event: WheelLike): void;
  handlePointerDown(event: PointerLike): void;
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
  const { lastTop, lastNativeTop, reseedBaselines } = useScrollBaselines();
  const { markProgrammaticScroll, attributeScroll, settleWrites, lastWriteAt, forgetWrites } = useProgrammaticWrites();
  const { signals, clearMutation, reset: resetSignals } = useFollowSignals(viewport);
  const { showJump, scheduleScrollState } = useJumpButtonState(followingRef);
  const { cancelJumpPin, startJumpPin } = useJumpPin({ viewport, followingRef, scrollToEndRef });
  const publish = useCallback(
    (next: boolean) => {
      followingRef.current = next;
      // The timeline anchor is part of the same decision, not a consequence of
      // the re-render that follows it.
      setAnchorBottomRef?.current?.(next);
      setFollowing((current) => (current === next ? current : next));
      // The jump control follows the pinned flag.
      if (viewport.current) scheduleScrollState(viewport.current);
    },
    [scheduleScrollState, setAnchorBottomRef, viewport]
  );

  /** The jump owns the viewport only until the reader asks for it back. */
  const markGesture = useCallback(() => {
    cancelJumpPin();
    const now = Date.now();
    gestureAt.current = now;
    readerMotionAt.current = now;
  }, [cancelJumpPin]);

  const hasGesture = useCallback(() => Date.now() - gestureAt.current < GESTURE_WINDOW_MS, []);
  // A scrollTop write cancels Chromium's wheel-scroll animation, so a wheel ramp holds measured-size corrections until its scroll events go quiet.
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
      if (!element || !followingRef.current) return;
      reportRelease(reason, scrollMetrics(element), previousTop);
      publish(false);
    },
    [publish, viewport]
  );

  const pause = useCallback(() => stop('pause'), [stop]);

  // A finger lift judges the scroll it ended; the judge is built after the
  // touch hook (it needs the finger), so the lift reaches it through a ref.
  const liftRef = useRef<() => void>(() => {});
  const onLift = useCallback(() => liftRef.current(), []);
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
  } = useFollowTouch({ viewport, markGesture, wheelScrolling, signals, lastWriteAt, onLift });

  /** Reader ownership ends the instant the reader asks for the tail. */
  const clearReaderGesture = useCallback(() => {
    gestureAt.current = 0;
    readerMotionAt.current = 0;
    wheelAt.current = 0;
    resetSignals();
    resetTouch();
  }, [resetSignals, resetTouch]);
  // On a phone the compositor scrolls from the first move past the slop before the main thread handles touchmove.
  const hasReaderScroll = useCallback(
    () =>
      hasGesture() ||
      hasTouchScroll() ||
      fingerOnGlass() ||
      keyUpRecent({ keyUpAt: signals.current.keyUpAt, now: Date.now() }) ||
      Date.now() - readerMotionAt.current < READER_SCROLL_IDLE_MS,
    [fingerOnGlass, hasGesture, hasTouchScroll, signals]
  );
  const restore = useCallback(() => scrollToBottom(false), [scrollToBottom]);
  const resetSessionKey = useRef(sessionKey);
  useEffect(() => {
    if (resetSessionKey.current === sessionKey) return;
    resetSessionKey.current = sessionKey;
    cancelJumpPin();
    forgetWrites();
    clearReaderGesture();
    reseedBaselines(viewport.current);
  }, [cancelJumpPin, clearReaderGesture, forgetWrites, reseedBaselines, sessionKey, viewport]);
  const judge = useFollowScrollJudge({
    viewport,
    followingRef,
    signals,
    lastTop,
    lastNativeTop,
    scheduleScrollState,
    noteScroll,
    attributeScroll,
    settleWrites,
    fingerOnGlass,
    hasReaderScroll,
    markReaderMotion,
    publish,
    stop,
    restore,
  });
  const handleScroll = useCallback(() => judge(true), [judge]);
  liftRef.current = () => {
    const element = viewport.current;
    if (!element) return;
    const state = signals.current;
    const metrics = scrollMetrics(element);
    if (liftLeftAboveEnd({ top: metrics.top, startTop: state.touchStartTop, distance: distanceFromBottom(metrics) })) {
      state.touchEndUpAt = Date.now();
    }
    if (
      touchLiftNeedsJudgement({
        scrolledNatively: state.touchScrolled,
        moved: state.touchMoved,
        top: metrics.top,
        startTop: state.touchStartTop,
        writesSinceStart: lastWriteAt() !== state.touchStartWriteAt,
      })
    ) {
      judge(false);
    }
    restore();
  };

  const handleWheel = useCallback(
    (event: WheelLike) => {
      if (!wheelIsVerticalScroll(event)) return;
      const root = event.currentTarget;
      const delta = normalizeWheelDelta(event);
      if (!delta) return;
      clearMutation();
      const target = boundaryTarget(root, event.target);
      // The timeline's own deferral (corrections wait for the ramp) follows the
      // scroller that actually takes the notch; the release below does not.
      if (target === root || boundaryGestureReached(target, delta)) {
        markGesture();
        wheelAt.current = Date.now();
        wheelMotionAt.current = 0;
      }
      if (event.deltaY < 0) {
        signals.current.wheelUpAt = Date.now();
        if (wheelReleasesFollow(event, scrollMetrics(root).top)) stop('wheel', lastTop.current);
      } else {
        signals.current.wheelUpAt = 0;
      }
    },
    [clearMutation, lastTop, markGesture, signals, stop]
  );

  const handleSelectionAutoScroll = useCallback(
    (delta: number) => {
      if (!Number.isFinite(delta) || delta === 0) return;
      markGesture();
      signals.current.pressAt = Date.now();
    },
    [markGesture, signals]
  );

  const handleInteraction = useCallback(() => {
    // A click is judged on its pointerdown (handlePointerDown).
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerLike) => {
      const root = event.currentTarget;
      clearMutation();
      // The scrollbar and empty padding are the scroller itself.
      if (event.target === root) markGesture();
      if (event.target === root && (event.button ?? 0) === 0 && event.pointerType !== 'touch') {
        signals.current.pressAt = Date.now();
      }
      // Pressing a control is about to change the content under the reader.
      if (activationReleasesFollow(root, event.target)) stop('press', lastTop.current);
    },
    [clearMutation, lastTop, markGesture, signals, stop]
  );

  const handlePointerUp = useCallback(() => {
    signals.current.pressAt = 0;
  }, [signals]);

  const handleKeyDown = useCallback(
    (event: {
      key: string;
      shiftKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
      target?: EventTarget | null;
      currentTarget?: HTMLDivElement;
    }) => {
      const root = event.currentTarget ?? viewport.current;
      if (!root) return;
      const target = event.target ?? null;
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        !editableTarget(target) &&
        activationReleasesFollow(root, target)
      ) {
        stop('activate', lastTop.current);
      }
      const direction = classifyScrollKey(event);
      if (direction === 'none') return;
      clearMutation();
      markGesture();
      // An up key does not release by itself: the scroll it causes does, within
      // the window, and the window keeps the end pin off meanwhile.
      if (direction === 'up') signals.current.keyUpAt = Date.now();
    },
    [clearMutation, lastTop, markGesture, signals, stop, viewport]
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
  const arm = useCallback(() => {
    cancelJumpPin();
    clearReaderGesture();
    publish(true);
    const element = viewport.current;
    if (element) scheduleScrollState(element);
  }, [cancelJumpPin, clearReaderGesture, publish, scheduleScrollState, viewport]);

  useFollowContentObserver({ viewport, content, contentMounted, sessionKey, scheduleScrollState });
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
