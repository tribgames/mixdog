import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';
import {
  GESTURE_WINDOW_MS,
  READER_SCROLL_IDLE_MS,
  chromePressHeld,
  classifyScrollKey,
  type GestureScroller,
  gestureScroller,
  keyUpRecent,
  liftLeftAboveEnd,
  pressOnScrollbar,
  scrollerTakes,
  touchLiftNeedsJudgement,
  wheelIsVerticalScroll,
  reportRearm,
  reportRelease,
  type ReleaseObservation,
  type WheelLike,
  type PointerLike,
  type TouchLike,
  normalizeWheelDelta,
  scrollMetrics,
  distanceFromBottom,
} from './transcript-follow-rules';
import { usePaneKey } from './pane-key-context';
import { useSurfaceActive } from './surface-activity';
import { pendingReaderPlace } from './transcript-list-reader-place';
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
  atWrittenOffset,
  chromePressHeld,
  classifyScrollKey,
  jumpButtonVisible,
  judgeScrollEvent,
  pressOnScrollbar,
  touchScrollLatchOpen,
  boundaryGestureReached,
  transcriptScrollGeometryRegistered,
} from './transcript-follow-rules';

interface TranscriptFollow {
  /** The end is kept: follow is on and no selection holds it. */
  following: boolean;
  /** Follow is on: the reader has not scrolled away (a selection may hold the end meanwhile). */
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
  /** A selection in the transcript began (true) or collapsed or left it (false). */
  handleSelectionHold(held: boolean): void;
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

/** Calls `onRelease` once: at the first pointerup or pointercancel, wherever it lands, or when the window loses focus.
 *  Returns what stops listening unheard. */
function awaitPointerRelease(onRelease: () => void): () => void {
  const types = ['pointerup', 'pointercancel'];
  const unlisten = (): void => {
    for (const type of types) window.removeEventListener(type, heard, true);
    window.removeEventListener('blur', heard);
  };
  const heard = (): void => {
    unlisten();
    onRelease();
  };
  for (const type of types) window.addEventListener(type, heard, true);
  window.addEventListener('blur', heard);
  return unlisten;
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
  // The run of notches a wheel is turning: its last notch and the scroller its first one reached.
  const wheelRun = useRef<{ at: number; scroller: GestureScroller }>({ at: 0, scroller: null });
  const { lastTop, lastNativeTop, lastExtent, reseedBaselines } = useScrollBaselines();
  const { markProgrammaticScroll, attributeScroll, settleWrites, lastWriteAt, forgetWrites } = useProgrammaticWrites();
  const { signals, reset: resetSignals } = useFollowSignals(viewport);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  // The session whose transcript holds a selection: it holds follow, writing no end under the text being selected. A
  // session entered starts with none.
  const heldSession = useRef<string | null>(null);
  const selectionHolds = useCallback(() => heldSession.current === sessionKeyRef.current, []);
  const settleAtEnd = useRef<() => boolean>(() => false);
  const arrived = useCallback(() => signals.current.arrived, [signals]);
  const session = useCallback(() => sessionKeyRef.current, []);
  const { showJump, scheduleScrollState } = useJumpButtonState({
    followingRef,
    holds: selectionHolds,
    arrived,
    session,
    atEnd: settleAtEnd,
  });
  const { cancelJumpPin, startJumpPin } = useJumpPin({ viewport, followingRef, scrollToEndRef });
  const publish = useCallback(
    (next: boolean) => {
      followingRef.current = next;
      // Follow taken back is what an arrival at the end was for: the next let-go arrives nowhere until the reader moves.
      if (next) signals.current.arrived = false;
      // The timeline anchor is part of the same decision, not a consequence of
      // the re-render that follows it. A held selection keeps the end unwritten, and follow says so with it.
      const kept = next && !selectionHolds();
      setAnchorBottomRef?.current?.(kept);
      setFollowing((current) => (current === kept ? current : kept));
      // The jump control follows the pinned flag.
      if (viewport.current) scheduleScrollState(viewport.current);
    },
    [scheduleScrollState, selectionHolds, setAnchorBottomRef, signals, viewport]
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
  // The scroll judge, built further down (it needs the touch hook); a press's release reaches it through this.
  const judgeRef = useRef<() => void>(() => {});
  // A press on the scrollbar, from its pointerdown; 0 with none.
  const pressedAt = useRef(0);
  /** Is a press on the scrollbar held? A lost release ends it as `chromePressHeld` does. */
  const pressHeld = useCallback(() => chromePressHeld({ pressedAt: pressedAt.current, now: Date.now() }), []);
  const nativeScrolling = useCallback(() => {
    if (pressHeld()) return true;
    const started = nativeAt.current;
    if (!started) return false;
    if (Date.now() - Math.max(started, nativeMotionAt.current) < GESTURE_WINDOW_MS) return true;
    nativeAt.current = 0;
    return false;
  }, [pressHeld]);
  // A press is held until its pointer is released, wherever that is: a drag that began on the scrollbar ends over the
  // composer or outside the window, where the viewport hears no pointerup.
  const releasePress = useRef<() => void>(() => undefined);
  const forgetPress = useRef<() => void>(() => undefined);
  const holdPress = useCallback(() => {
    // A new press takes the place of one whose release never came.
    forgetPress.current();
    pressedAt.current = Date.now();
    nativeAt.current = Date.now();
    nativeMotionAt.current = 0;
    const forget = (): void => {
      unlisten();
      releasePress.current = () => undefined;
      forgetPress.current = () => undefined;
    };
    const release = (): void => {
      forget();
      const ended = pressedAt.current;
      pressedAt.current = 0;
      if (!ended) return;
      nativeAt.current = Date.now();
      nativeMotionAt.current = 0;
      // A thumb let go near the end is the reader coming back: the scroll it made is judged without the press.
      signals.current.barAt = 0;
      judgeRef.current();
    };
    const unlisten = awaitPointerRelease(release);
    releasePress.current = release;
    forgetPress.current = forget;
  }, [signals]);
  useEffect(() => () => releasePress.current(), []);
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
    (reason = 'gesture', previousTop = 0, observed?: ReleaseObservation) => {
      const element = viewport.current;
      if (!element || !followingRef.current) return;
      reportRelease(reason, scrollMetrics(element), previousTop, observed);
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
  const handleSelectionHold = useCallback(
    (held: boolean) => {
      const was = selectionHolds();
      heldSession.current = held ? sessionKeyRef.current : null;
      const element = viewport.current;
      if (element) scheduleScrollState(element);
      if (was === held || !followingRef.current) return;
      setAnchorBottomRef?.current?.(!held);
      setFollowing(!held);
      if (!held) restore();
    },
    [restore, scheduleScrollState, selectionHolds, setAnchorBottomRef, viewport]
  );
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
    lastExtent,
    scheduleScrollState,
    noteScroll,
    attributeScroll,
    settleWrites,
    fingerOnGlass,
    hasTouchScroll,
    hasReaderScroll,
    markReaderMotion,
    publish,
    stop,
    restore,
  });
  const handleScroll = useCallback(() => judge(true), [judge]);
  judgeRef.current = () => judge(false);
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
      // A notch within the gesture window of the last one continues its run, latched to the scroller its first notch
      // reached. A scroller inside the transcript that takes the notch moves; the transcript does not.
      const run = wheelRun.current;
      const now = Date.now();
      if (now - run.at >= GESTURE_WINDOW_MS) run.scroller = gestureScroller(root, event.target);
      run.at = now;
      if (scrollerTakes(run.scroller, delta)) return;
      if (delta > 0) {
        signals.current.wheelUpAt = 0;
        // A notch down at the kept end moves nothing: the end goes on being kept.
        if (followingRef.current) return;
      } else {
        // The notch vouches for the scroll it makes; that scroll, once it moves the view off the end, lets go.
        signals.current.wheelUpAt = now;
      }
      markGesture();
      wheelAt.current = now;
      wheelMotionAt.current = 0;
    },
    [markGesture, signals]
  );

  // A selection drag's press ends where its pointer is released, wherever that is.
  const selectionPress = useRef<(() => void) | null>(null);
  const handleSelectionAutoScroll = useCallback(
    (delta: number) => {
      if (!Number.isFinite(delta) || delta === 0) return;
      markGesture();
      signals.current.selectUpAt = delta < 0 ? Date.now() : 0;
      selectionPress.current ??= awaitPointerRelease(() => {
        selectionPress.current = null;
        signals.current.selectUpAt = 0;
      });
    },
    [markGesture, signals]
  );
  useEffect(() => () => selectionPress.current?.(), []);

  const handleInteraction = useCallback(() => {
    // A click, wherever it lands, leaves follow as it is.
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerLike) => {
      const root = event.currentTarget;
      // A press on the scrollbar's track takes the scroll; one on the scroller's padding is no scroll at all.
      if (pressOnScrollbar(root, event) && (event.button ?? 0) === 0 && event.pointerType !== 'touch') {
        markGesture();
        signals.current.barAt = Date.now();
        // The press's moves are judged against the extent it began over, whatever the content did before it.
        lastExtent.current = root.clientHeight > 0 ? root.scrollHeight - root.clientHeight : 0;
        holdPress();
      }
    },
    [holdPress, lastExtent, markGesture, signals]
  );

  const handlePointerUp = useCallback(() => {
    signals.current.barAt = 0;
    releasePress.current();
  }, [signals]);

  const handleKeyDown = useCallback(
    (event: {
      key: string;
      shiftKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
      target?: EventTarget | null;
    }) => {
      const direction = classifyScrollKey(event);
      if (direction === 'none') return;
      // An up key does not release by itself: the scroll it causes does, within the window, and the window keeps the
      // end pin off meanwhile. A down key closes it: the scroll it causes is the reader coming back.
      signals.current.keyUpAt = direction === 'up' ? Date.now() : 0;
      // A key down at the kept end moves nothing: the end goes on being kept.
      if (direction === 'down' && followingRef.current) return;
      markGesture();
      nativeAt.current = Date.now();
      nativeMotionAt.current = 0;
    },
    [markGesture, signals]
  );

  const rearm = useCallback(
    (reason: string) => {
      const element = viewport.current;
      if (element && !followingRef.current) reportRearm(reason, scrollMetrics(element));
      publish(true);
    },
    [publish, viewport]
  );
  const resume = useCallback(() => {
    cancelJumpPin();
    // Before any write: the timeline refuses every end write while a gesture
    // window is open, so the jump has to close that window itself.
    clearReaderGesture();
    // The reader asked for the end: a selection left above it holds nothing.
    heldSession.current = null;
    rearm('jump');
    scrollToBottom(true);
    startJumpPin();
    const element = viewport.current;
    if (element) scheduleScrollState(element);
  }, [cancelJumpPin, clearReaderGesture, rearm, scheduleScrollState, scrollToBottom, startJumpPin, viewport]);
  const arm = useCallback(() => {
    cancelJumpPin();
    clearReaderGesture();
    rearm('arm');
    const element = viewport.current;
    if (element) scheduleScrollState(element);
  }, [cancelJumpPin, clearReaderGesture, rearm, scheduleScrollState, viewport]);

  // Standing at the end is following: with nothing of the reader's in flight (a gesture, a press, a place the pane is
  // being opened at), a view with follow off that stands at the end takes follow back. A surface off screen waits.
  const pane = usePaneKey();
  const active = useSurfaceActive();
  const activeRef = useRef(active);
  activeRef.current = active;
  settleAtEnd.current = () => {
    if (!activeRef.current) return false;
    if (hasReaderScroll() || pressHeld() || pendingReaderPlace(pane, sessionKeyRef.current)) return true;
    rearm('end');
    // What streamed in while the reader's input ended is the end's now.
    scrollToBottom(false);
    return false;
  };
  useEffect(() => {
    if (active && viewport.current) scheduleScrollState(viewport.current);
  }, [active, scheduleScrollState, viewport]);

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
    handleSelectionHold,
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
