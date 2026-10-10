import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';
import {
  GESTURE_WINDOW_MS,
  READER_SCROLL_IDLE_MS,
  TRANSCRIPT_OVERFLOW_ANCHOR,
  SCROLL_KEYS,
  POINTER_DRAG_PX,
  PROGRAMMATIC_WINDOW_MS,
  PROGRAMMATIC_MEMORY,
  JUMP_PIN_MS,
  JUMP_PIN_SETTLE_FRAMES,
  grewWhileAtBottom,
  isTranscriptChromeTarget,
  pointerShouldReleaseFollow,
  selectionAutoScrollShouldReleaseFollow,
  readerScrollShouldReleaseFollow,
  touchMoveShouldReleaseFollow,
  touchScrollLatchOpen,
  wheelShouldReleaseFollow,
  boundaryGestureReached,
  programmaticWriteMatches,
  reportRelease,
  type WheelLike,
  type PointerLike,
  type TouchLike,
  normalizeWheelDelta,
  boundaryTarget,
  transcriptScrollGeometryRegistered,
  scrollMetrics,
  distanceFromBottom,
  canScroll,
  scrollShouldReattachFollow,
  jumpButtonVisible,
} from './transcript-follow-rules';
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
 * The hook owns userScrolled, the 250ms gesture window, the 10px return band,
 * and the content ResizeObserver. TranscriptList owns EVERY scroll write:
 * virtual row geometry, append following, and measured-size anchoring.
 * This hook asks for scrollToEnd only when follow resumes. The timeline owns
 * viewport resizing as well as row geometry.
 */
interface TranscriptFollow {
  following: boolean;
  followingRef: RefObject<boolean>;
  showJump: boolean;
  hasScrollGesture(): boolean;
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
  const [showJump, setShowJump] = useState(false);
  const followingRef = useRef(true);
  const gestureAt = useRef(0);
  const readerMotionAt = useRef(0);
  const touchGesture = useRef<number | undefined>(undefined);
  // Touch scroll ownership: armed by a drag that actually moves the transcript,
  // held for as long as the finger is down, and closed by scrollend (or the
  // idle fallback) once the fling is over.
  const touchLatched = useRef(false);
  const touchDown = useRef(false);
  // A touch keeps targeting the element it started on. When virtualization
  // unmounts that row mid-drag, its touchend never reaches the viewport, and
  // "finger down" stayed true until the NEXT touch: every row size deferred
  // for reader motion then stayed deferred and the geometry never recovered.
  // A detached target ends the finger's ownership; the scroll-idle fallback
  // still owns the fling.
  const touchTarget = useRef<{ isConnected?: boolean } | null>(null);
  const fingerOnGlass = useCallback(() => {
    if (!touchDown.current) return false;
    if (touchTarget.current?.isConnected === false) {
      touchDown.current = false;
      return false;
    }
    return true;
  }, []);
  const touchScrollAt = useRef(0);
  const pointerGesture = useRef<{ x: number; y: number } | undefined>(undefined);
  const chromeScroll = useRef(false);
  // A content press is not a scroll gesture. A drag that has moved far enough
  // MAY become one if Chromium autoscrolls the transcript up.
  const pointerDragging = useRef(false);
  const scrollStateFrame = useRef(0);
  const scrollStateTarget = useRef<HTMLDivElement | null>(null);
  // Offsets WRITTEN by the virtual timeline (append follow, measured-size
  // adjustments, entry anchoring) all route through its scrollToFn, which
  // reports them here. They are the timeline keeping its own promise, never
  // reader intent — counted as a gesture they released follow mid-stream
  // (user: 자동스크롤이 너무 자주 풀린다).
  const programmatic = useRef<{ top: number; time: number }[]>([]);
  // Last observed offset, so a release demands an actual UPWARD move.
  const lastTop = useRef(0);
  // Last observed content height, so a growth commit can be judged against the
  // bottom it had BEFORE that growth (see grewWhileAtBottom).
  const lastScrollHeight = useRef(0);
  // Distance from the bottom as of the last event that was NOT a content
  // mutation — the pre-mutation snapshot a plain listener takes.
  const lastDistance = useRef(0);
  // Jump-to-latest re-pin loop: frame handle, deadline, settled-frame count.
  const jumpPinFrame = useRef(0);
  const jumpPinUntil = useRef(0);
  const jumpPinSettled = useRef(0);

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

  const cancelJumpPin = useCallback(() => {
    if (jumpPinFrame.current) window.cancelAnimationFrame(jumpPinFrame.current);
    jumpPinFrame.current = 0;
    jumpPinUntil.current = 0;
    jumpPinSettled.current = 0;
  }, []);

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
    programmatic.current = [];
    gestureAt.current = 0;
    readerMotionAt.current = 0;
    touchGesture.current = undefined;
    touchLatched.current = false;
    touchDown.current = false;
    touchScrollAt.current = 0;
    pointerGesture.current = undefined;
    pointerDragging.current = false;
    chromeScroll.current = false;
    const element = viewport.current;
    if (element) {
      try {
        const metrics = scrollMetrics(element);
        lastTop.current = metrics.top;
        lastScrollHeight.current = metrics.maxScrollTop + metrics.viewportHeight;
        lastDistance.current = distanceFromBottom(metrics);
      } catch {
        /* layout only */
      }
    } else {
      lastTop.current = 0;
      lastScrollHeight.current = 0;
      lastDistance.current = 0;
    }
  }, [cancelJumpPin, sessionKey, viewport]);

  /** The jump owns the viewport only until the reader asks for it back. */
  const markGesture = useCallback(() => {
    cancelJumpPin();
    const now = Date.now();
    gestureAt.current = now;
    readerMotionAt.current = now;
  }, [cancelJumpPin]);

  /** Reader ownership ends the instant the reader asks for the tail. */
  const clearReaderGesture = useCallback(() => {
    gestureAt.current = 0;
    readerMotionAt.current = 0;
    touchGesture.current = undefined;
    touchLatched.current = false;
    touchDown.current = false;
    touchScrollAt.current = 0;
    pointerGesture.current = undefined;
    pointerDragging.current = false;
    chromeScroll.current = false;
  }, []);
  const hasGesture = useCallback(() => Date.now() - gestureAt.current < GESTURE_WINDOW_MS, []);
  const markReaderMotion = useCallback(() => {
    readerMotionAt.current = Date.now();
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
  const hasReaderScroll = useCallback(
    () => hasGesture() || hasTouchScroll() || Date.now() - readerMotionAt.current < READER_SCROLL_IDLE_MS,
    [hasGesture, hasTouchScroll]
  );
  const markProgrammaticScroll = useCallback((top: number, intended?: number) => {
    const time = Date.now();
    const queue = programmatic.current.filter((entry) => time - entry.time < PROGRAMMATIC_WINDOW_MS);
    queue.push({ top: Math.round(top), time });
    if (typeof intended === 'number' && Number.isFinite(intended)) {
      queue.push({ top: Math.round(intended), time });
    }
    programmatic.current = queue.slice(-PROGRAMMATIC_MEMORY);
  }, []);

  const isProgrammatic = useCallback((top: number) => {
    const time = Date.now();
    const queue = programmatic.current.filter((entry) => time - entry.time < PROGRAMMATIC_WINDOW_MS);
    programmatic.current = queue;
    if (!queue.length) return false;
    return programmaticWriteMatches({ writes: queue, top, now: time });
  }, []);

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

  const updateScrollState = useCallback((element: HTMLDivElement) => {
    // No timeline mounted yet: nothing to jump to, and the DOM fallback would
    // force a layout of the opening pane from this animation frame.
    const jump = transcriptScrollGeometryRegistered(element) && jumpButtonVisible(scrollMetrics(element));
    setShowJump((current) => (current === jump ? current : jump));
  }, []);

  const scheduleScrollState = useCallback(
    (element: HTMLDivElement) => {
      scrollStateTarget.current = element;
      if (scrollStateFrame.current) return;
      scrollStateFrame.current = window.requestAnimationFrame(() => {
        scrollStateFrame.current = 0;
        const target = scrollStateTarget.current;
        scrollStateTarget.current = null;
        if (target) updateScrollState(target);
      });
    },
    [updateScrollState]
  );

  const handleScroll = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    scheduleScrollState(element);
    // Every frame of a touch scroll — finger-driven or inertial — keeps the
    // latch alive, so the idle fallback can only close it once the native
    // stream has actually stopped delivering.
    if (touchLatched.current) touchScrollAt.current = Date.now();
    const previousTop = lastTop.current;
    // The offset is the only layout value read here; the extent comes from the
    // timeline's geometry.
    const metrics = scrollMetrics(element, undefined, element.scrollTop);
    const top = metrics.top;
    lastTop.current = top;
    const programmaticScroll = isProgrammatic(top);
    if (transcriptScrollDiagnosticsEnabled() && Math.abs(top - previousTop) >= 8) {
      logTranscriptScroll('viewport-move', {
        from: previousTop,
        to: top,
        delta: top - previousTop,
        programmatic: programmaticScroll,
        following: followingRef.current,
      });
    }
    // A native reader ramp may outlive the initial 250ms gesture window.
    // Extend ownership only from real movement, never from a virtual-core
    // correction, so compensation resumes once wheel/inertia actually stops.
    if (top !== previousTop && !programmaticScroll && hasReaderScroll()) {
      markReaderMotion();
    }
    lastScrollHeight.current = metrics.maxScrollTop + metrics.viewportHeight;
    // A scroll event is the reader's (or the core's) position talking, not a
    // content mutation: it is exactly the snapshot the content observer needs.
    lastDistance.current = distanceFromBottom(metrics);
    // Re-attaching at the tail is NOT gesture-gated. Smooth-scroll and inertial
    // tails deliver their last frames well after the 250ms window closes, and a
    // streaming turn keeps pushing the bottom down, so requiring an open
    // gesture window here left a reader who scrolled back to the end detached
    // forever — new output then piled up below the fold (user: 내려도 다시 안
    // 붙고 텍스트가 아래로 묻힌다). Only the RELEASE decision needs gesture
    // attribution; a detached viewport cannot release again.
    if (!followingRef.current) {
      // The timeline's own corrective writes are not the reader coming back.
      if (programmaticScroll) return;
      // The tail is regained by the next append instead of a jump: the reader's
      // offset is never rolled back.
      if (scrollShouldReattachFollow(metrics, previousTop)) publish(true);
      return;
    }
    // A content click must not open the gesture window: a stream wobble in
    // the next 250ms would then unlock follow (user: 스크립트 클릭하면
    // 오토스크롤·줄바꿈이 풀린다). Selection autoscroll is the exception —
    // pointerDragging is armed only after a real 4px drag.
    if (
      readerScrollShouldReleaseFollow({
        programmatic: programmaticScroll,
        chromePointer: chromeScroll.current,
        upwardMove: previousTop - top,
      })
    ) {
      stop('scroll', previousTop);
    }
  }, [hasReaderScroll, isProgrammatic, markReaderMotion, publish, scheduleScrollState, stop, viewport]);

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
      // Wheel rule: an upward wheel is explicit intent
      // and releases immediately, however small it is. Re-attaching is the side
      // that carries the slack (reattachBand).
      if (wheelShouldReleaseFollow({ delta, transcriptReached })) {
        stop('wheel', lastTop.current);
      }
    },
    [markGesture, stop]
  );

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
    [markGesture, stop]
  );

  const handlePointerUp = useCallback(() => {
    pointerDragging.current = false;
    pointerGesture.current = undefined;
    chromeScroll.current = false;
  }, []);

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
    [markGesture, stop]
  );

  const handleTouchStart = useCallback((event: TouchLike) => {
    touchGesture.current = event.touches[0]?.clientY;
    touchDown.current = true;
    touchTarget.current = event.target as { isConnected?: boolean } | null;
    touchScrollAt.current = Date.now();
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
    [markGesture, stop]
  );

  const handleTouchEnd = useCallback(() => {
    touchGesture.current = undefined;
    touchDown.current = false;
    // The fling outlives the finger. The latch stays open; scrollend or the
    // idle fallback is what closes it.
    touchScrollAt.current = Date.now();
  }, []);

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
    [markGesture, stop, viewport]
  );

  // Chromium's wheel/fling animation keeps writing scrollTop after the click,
  // and it cannot be cancelled from JS — so the tail is simply re-taken every
  // frame until the offset holds still or the short deadline expires. A new
  // reader gesture (markGesture) cancels the loop, so the reader always wins.
  const startJumpPin = useCallback(() => {
    if (!viewport.current) return;
    jumpPinUntil.current = Date.now() + JUMP_PIN_MS;
    jumpPinSettled.current = 0;
    const step = () => {
      jumpPinFrame.current = 0;
      const root = viewport.current;
      if (!root || !followingRef.current || Date.now() >= jumpPinUntil.current) {
        cancelJumpPin();
        return;
      }
      if (distanceFromBottom(scrollMetrics(root)) < 2) {
        jumpPinSettled.current += 1;
        if (jumpPinSettled.current >= JUMP_PIN_SETTLE_FRAMES) {
          cancelJumpPin();
          return;
        }
      } else {
        jumpPinSettled.current = 0;
        scrollToEndRef?.current?.('auto');
      }
      jumpPinFrame.current = window.requestAnimationFrame(step);
    };
    if (jumpPinFrame.current) window.cancelAnimationFrame(jumpPinFrame.current);
    jumpPinFrame.current = window.requestAnimationFrame(step);
  }, [cancelJumpPin, scrollToEndRef, viewport]);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: contentMounted, following and sessionKey are re-attach triggers (a fresh observer re-seeds the baselines) though the body reads following through followingRef
  useEffect(() => {
    const target = content.current;
    const element = viewport.current;
    if (!target || !element) return undefined;
    // Virtual-core owns every measured-size correction. Browser anchoring must
    // stay off after follow releases too; otherwise both authorities compensate
    // the same above-viewport resize and reverse each other during upward
    // wheel, touch, and scrollbar motion.
    element.style.overflowAnchor = TRANSCRIPT_OVERFLOW_ANCHOR;
    // Chromium always provides ResizeObserver. The renderer's jsdom harness
    // intentionally omits it in tests that do not exercise layout delivery.
    if (typeof ResizeObserver !== 'function') return undefined;
    const seed = scrollMetrics(element);
    let viewportHeight = Math.round(seed.viewportHeight);
    // Seed the growth baseline with the height already on screen so the first
    // observation cannot report the whole transcript as this commit's growth.
    lastScrollHeight.current = seed.maxScrollTop + seed.viewportHeight;
    lastDistance.current = distanceFromBottom(seed);
    // A fresh observer delivers the CURRENT box of every target it starts
    // watching — that first callback is an attach report, not a mutation. This
    // effect re-runs on every follow flip, so writing on it re-pinned the tail
    // one frame after the reader had released it (user: 위로 올려도 다시
    // 내려온다). The attach delivery may only seed the baselines.
    let attachDelivery = true;
    const observer = new ResizeObserver((entries) => {
      const root = viewport.current;
      if (!root) return;
      scheduleScrollState(root);
      // The viewport's own box, when this delivery carries it, is the freshest
      // height; otherwise the last one observed still holds.
      const box = entries.find((entry) => entry.target === root)?.borderBoxSize?.[0];
      const height = box ? Math.round(box.blockSize) : viewportHeight;
      const metrics = scrollMetrics(root, height);
      const viewportHeightChanged = height !== viewportHeight;
      viewportHeight = height;
      const scrollHeight = metrics.maxScrollTop + metrics.viewportHeight;
      const growth = scrollHeight - lastScrollHeight.current;
      lastScrollHeight.current = scrollHeight;
      const distance = distanceFromBottom(metrics);
      // The pre-mutation snapshot: the distance left by the last event that
      // was NOT this content mutation.
      const distanceBefore = lastDistance.current;
      lastDistance.current = distance;
      // Auto-scroll rule: a transcript that no longer
      // OVERFLOWS holds no reading position, so it re-arms follow. The CONTENT
      // side of that rule is driven by the rows commit in Conversation, not by
      // a second observer here — virtual-core stays the only content-growth
      // scroll authority.
      if (!canScroll(metrics)) {
        if (!followingRef.current) publish(true);
        return;
      }
      if (attachDelivery) {
        attachDelivery = false;
        return;
      }
      if (!followingRef.current) {
        // A growing commit while the viewport still sat at the previous bottom
        // means
        // the reader never left the tail, so the flag is restored and the new
        // bottom is taken. A turn that opens with a tool card and no preamble
        // lands its whole card in one commit, which is precisely the case the
        // after-the-fact 10px band could never recognise.
        if (viewportHeightChanged) return;
        // A growth the virtual core compensated itself — a row ABOVE the
        // reading offset resolving from its estimate — lands with the offset
        // sitting on the core's own corrective write. That is the timeline
        // holding the reader still, never the reader arriving at the tail.
        if (isProgrammatic(metrics.top)) return;
        // Nor is a frame the reader is actively scrolling through: the wheel
        // that just released follow is still animating its notch.
        if (hasGesture()) return;
        if (grewWhileAtBottom({ distanceBefore, growth })) {
          publish(true);
          scrollToBottom(false);
        }
        return;
      }
      // Both viewport resizing and content growth are pinned by the timeline
      // after its geometry is current, never by a second observer here.
    });
    // This observer only maintains follow intent and its growth baseline.
    observer.observe(element);
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    content,
    contentMounted,
    following,
    hasGesture,
    isProgrammatic,
    publish,
    scheduleScrollState,
    scrollToBottom,
    sessionKey,
    viewport,
  ]);

  useEffect(
    () => () => {
      if (scrollStateFrame.current) window.cancelAnimationFrame(scrollStateFrame.current);
      if (jumpPinFrame.current) window.cancelAnimationFrame(jumpPinFrame.current);
    },
    []
  );

  return {
    following,
    followingRef,
    showJump,
    hasScrollGesture: hasReaderScroll,
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
