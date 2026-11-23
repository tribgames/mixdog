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
  pressIsOnRowContent,
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
import { type TouchContacts, useFollowTouch } from './use-follow-touch';
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
  handleTouchStart(event: TouchLike & TouchContacts): void;
  handleTouchMove(event: TouchLike): void;
  /** A touchend or touchcancel: the touch ends with the last contact that started on the transcript. */
  handleTouchEnd(event: TouchContacts): void;
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
  // A scroll key or the scrollbar moves the viewport natively too: a scrollTop write under it fights a key's smooth
  // scroll and a dragged thumb, so corrections are held through it as through a wheel ramp, until its scrolls go quiet.
  const nativeAt = useRef(0);
  const nativeMotionAt = useRef(0);
  const barHeld = useRef(false);
  const nativeScrolling = useCallback(() => {
    if (barHeld.current) return true;
    const started = nativeAt.current;
    if (!started) return false;
    if (Date.now() - Math.max(started, nativeMotionAt.current) < GESTURE_WINDOW_MS) return true;
    nativeAt.current = 0;
    return false;
  }, []);
  // A press on the scroller is held until its pointer is released, wherever that is: a drag that began on the scrollbar
  // or in the padding ends over the composer or outside the window, where the viewport hears no pointerup.
  const releaseBar = useRef<() => void>(() => undefined);
  const holdBar = useCallback(() => {
    releaseBar.current();
    barHeld.current = true;
    nativeAt.current = Date.now();
    nativeMotionAt.current = 0;
    const release = (): void => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', release);
      releaseBar.current = () => undefined;
      if (!barHeld.current) return;
      barHeld.current = false;
      nativeAt.current = Date.now();
      nativeMotionAt.current = 0;
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', release);
    releaseBar.current = release;
  }, []);
  useEffect(() => () => releaseBar.current(), []);
  const markReaderMotion = useCallback(() => {
    const now = Date.now();
    readerMotionAt.current = now;
    if (wheelScrolling()) wheelMotionAt.current = now;
    if (nativeScrolling()) nativeMotionAt.current = now;
  }, [nativeScrolling, wheelScrolling]);
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
    holdsScrollCorrections: touchOrWheelHolds,
    touchHoldsCorrections,
    noteScroll,
    reset: resetTouch,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useFollowTouch({ viewport, markGesture, wheelScrolling, signals, lastWriteAt, onLift });

  const holdsScrollCorrections = useCallback(
    () => touchOrWheelHolds() || nativeScrolling(),
    [nativeScrolling, touchOrWheelHolds]
  );

  /** Reader ownership ends the instant the reader asks for the tail. A press still held on the scroller is not ended
   *  here: the thumb dragged to the end and back is one press, and the list writes no offset under it until it lifts. */
  const clearReaderGesture = useCallback(() => {
    gestureAt.current = 0;
    readerMotionAt.current = 0;
    wheelAt.current = 0;
    nativeAt.current = 0;
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

  // A press on a row's content is a click until it selects text: only then is the text under the pointer being read.
  const releaseSelectionWatch = useRef<() => void>(() => undefined);
  const watchSelection = useCallback(
    (root: HTMLDivElement) => {
      releaseSelectionWatch.current();
      const document = root.ownerDocument;
      const view = document.defaultView;
      const end = (): void => {
        document.removeEventListener('selectionchange', selected);
        view?.removeEventListener('pointerup', end, true);
        view?.removeEventListener('pointercancel', end, true);
        view?.removeEventListener('blur', end);
        releaseSelectionWatch.current = () => undefined;
      };
      const selected = (): void => {
        const selection = document.getSelection();
        if (!selection || selection.isCollapsed || !root.contains(selection.anchorNode)) return;
        end();
        stop('select', lastTop.current);
      };
      document.addEventListener('selectionchange', selected);
      view?.addEventListener('pointerup', end, true);
      view?.addEventListener('pointercancel', end, true);
      view?.addEventListener('blur', end);
      releaseSelectionWatch.current = end;
    },
    [lastTop, stop]
  );
  useEffect(() => () => releaseSelectionWatch.current(), []);

  const handlePointerDown = useCallback(
    (event: PointerLike) => {
      const root = event.currentTarget;
      clearMutation();
      // The scrollbar and empty padding are the scroller itself.
      if (event.target === root) markGesture();
      if (event.target === root && (event.button ?? 0) === 0 && event.pointerType !== 'touch') {
        signals.current.pressAt = Date.now();
        holdBar();
      }
      // Pressing a control is about to change the content under the reader.
      if (activationReleasesFollow(root, event.target)) stop('press', lastTop.current);
      else if (pressIsOnRowContent(root, event)) watchSelection(root);
    },
    [clearMutation, lastTop, markGesture, signals, stop, watchSelection]
  );

  const handlePointerUp = useCallback(() => {
    signals.current.pressAt = 0;
    releaseBar.current();
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
      nativeAt.current = Date.now();
      nativeMotionAt.current = 0;
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
