import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";

/**
 * Transcript auto-scroll + session scroll-gesture grammar.
 *
 * The hook owns userScrolled, the 250ms gesture window, the 10px return band,
 * and the content ResizeObserver. TranscriptList owns EVERY scroll write:
 * virtual row geometry, append following, and measured-size anchoring.
 * This hook asks for scrollToEnd only on an explicit resume or a viewport
 * resize that the core cannot see.
 */
const GESTURE_WINDOW_MS = 250;
// Keep reader ownership alive between native wheel/touch/scrollbar frames.
// Unlike virtual-core's isScrolling this excludes the timeline's own writes,
// so late idle measurements can still compensate in a continuous burst.
const READER_SCROLL_IDLE_MS = 180;
export const BOTTOM_THRESHOLD_PX = 10;
// A virtualized transcript must have exactly one geometry authority.
// Browser anchoring and virtual-core both compensate rows that resize above
// the viewport, so enabling both makes upward reader motion oscillate.
export const TRANSCRIPT_OVERFLOW_ANCHOR = "none";
// Re-attaching tolerates more slack than releasing does: while a turn streams,
// the tail keeps moving away between the reader's last scroll frame and this
// handler, so a deliberate scroll back down lands tens of px above a bottom
// that has already grown.
const REATTACH_THRESHOLD_PX = 32;
const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
// A release must be a real upward move, not sub-pixel reflow noise. Fractional
// row heights under a parallel stream deliver 1px scrollTop wobble that is not
// reader intent; a plain scroll listener never sees it because it does not
// virtualize (user: 병렬 작업 중 타이핑하면 스크롤이 계속 풀린다).
const RELEASE_MOVE_PX = 1;
const POINTER_DRAG_PX = 4;
// Programmatic writes arrive in BURSTS: one measurement commit can move the
// offset several times (core adjustment, spacer growth, end re-pin) before a
// single scroll event lands. Remembering only the last one made every earlier
// write in the burst read as reader intent.
const PROGRAMMATIC_WINDOW_MS = 1_500;
const PROGRAMMATIC_MEMORY = 12;
// Jump-to-latest must BEAT the motion it interrupts. Both this hook and the
// virtual timeline gate every end write on reader ownership, so a click that
// landed inside a live gesture window (wheel ramp, fling tail, scrollbar drag)
// was swallowed whole: the transcript kept coasting and the offset never moved
// (user: 스크롤 중에 최신으로 이동을 눌러도 즉시 멈추지 않는다). The jump
// therefore drops reader ownership first, then re-pins the tail frame by frame
// until the residual momentum Chromium still delivers is overwritten.
const JUMP_PIN_MS = 400;
const JUMP_PIN_SETTLE_FRAMES = 3;

/**
 * Content-commit bottom rule: was the viewport at
 * the bottom BEFORE this growth? — and they answer it from a SNAPSHOT taken
 * before the mutation, never from the distance the mutation left behind.
 *
 * Deriving it after the fact (`distance < threshold + growth`) cannot tell
 * "the tail grew below me" from "a row ABOVE me resolved from its estimate and
 * pushed everything down". An idle transcript does the latter constantly — a
 * tool card measured at 60px resolves to hundreds — so a reader parked far
 * above the tail satisfied the after-the-fact band and was yanked back to the
 * bottom (user: 멈춰 있는 세션에서도 위로 못 올린다).
 */
export function grewWhileAtBottom({
  distanceBefore,
  growth,
  threshold = BOTTOM_THRESHOLD_PX,
}: {
  /** Distance from the bottom BEFORE the mutation that produced `growth`. */
  distanceBefore: number;
  growth: number;
  threshold?: number;
}): boolean {
  if (!Number.isFinite(distanceBefore) || !Number.isFinite(growth)) return false;
  if (growth <= 0) return false;
  return distanceBefore < threshold;
}

/** Scrollbar / empty padding: the event target IS the overflow root. */
function isTranscriptChromeTarget(
  root: EventTarget | null,
  target: EventTarget | null,
): boolean {
  return root != null && target === root;
}

/** Click, caret, and in-place selection stay armed. Only an upward leave
 *  from the tail unlocks follow (and with it end-anchored wrap). */
export function pointerShouldReleaseFollow({
  distance,
  upwardMove,
  threshold = BOTTOM_THRESHOLD_PX,
}: {
  distance: number;
  upwardMove: number;
  threshold?: number;
}): boolean {
  if (!Number.isFinite(distance) || !Number.isFinite(upwardMove)) return false;
  if (distance < threshold) return false;
  return upwardMove > RELEASE_MOVE_PX;
}

export function selectionAutoScrollShouldReleaseFollow(delta: number): boolean {
  return Number.isFinite(delta) && delta < 0;
}

/** Follow releases only on a real reader leave: wheel, scrollbar, or key.
 *  Tool resize and content clicks change scrollTop but are not a leave. */
export function readerScrollShouldReleaseFollow({
  programmatic,
  chromePointer,
  upwardMove,
}: {
  programmatic: boolean;
  chromePointer: boolean;
  upwardMove: number;
}): boolean {
  if (programmatic || !chromePointer) return false;
  return upwardMove > RELEASE_MOVE_PX;
}

/** A touch drag toward older history releases follow only when the gesture
 *  reaches the transcript itself. A nested code/tool scroller keeps ownership
 *  until its own leading boundary is reached. */
export function touchMoveShouldReleaseFollow({
  delta,
  transcriptReached,
}: {
  /** Native scroll delta: negative moves the transcript toward older rows. */
  delta: number;
  transcriptReached: boolean;
}): boolean {
  if (!Number.isFinite(delta) || !transcriptReached) return false;
  return -delta > RELEASE_MOVE_PX;
}

/** A wheel notch toward older history releases follow as soon as the gesture
 *  reaches the transcript — either directly or through a nested scroller that
 *  is already at its leading boundary. Unlike touch, no minimum travel applies:
 *  a wheel notch is deliberate by construction. */
export function wheelShouldReleaseFollow({
  delta,
  transcriptReached,
}: {
  /** Normalized wheel delta: negative moves the transcript toward older rows. */
  delta: number;
  transcriptReached: boolean;
}): boolean {
  if (!Number.isFinite(delta) || !transcriptReached) return false;
  return delta < 0;
}

/** Does a scroller own this delta, or has it reached its boundary and handed
 *  the gesture to the transcript? Pure geometry so it can be checked without a
 *  live layout. */
export function boundaryGestureReached(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  delta: number,
): boolean {
  const max = metrics.scrollHeight - metrics.clientHeight;
  if (max <= 1) return true;
  if (!delta) return false;
  if (delta < 0) return metrics.scrollTop + delta <= 0;
  return delta > max - metrics.scrollTop;
}

/** Does this offset belong to a write the timeline itself made? Bursts are
 *  remembered, so an earlier write in the same commit still counts. */
export function programmaticWriteMatches({
  writes,
  top,
  now,
  windowMs = PROGRAMMATIC_WINDOW_MS,
}: {
  writes: readonly { top: number; time: number }[];
  top: number;
  now: number;
  windowMs?: number;
}): boolean {
  const rounded = Math.round(top);
  return writes.some((entry) =>
    now - entry.time < windowMs && Math.abs(rounded - entry.top) < 2);
}

function reportRelease(reason: string, element: HTMLElement, previousTop: number): void {
  try {
    window.mixdogDesktop?.perfLog?.(
      `transcript-follow-release reason=${reason}`
      + ` top=${Math.round(element.scrollTop)}`
      + ` delta=${Math.round(element.scrollTop - previousTop)}`
      + ` distance=${Math.round(element.scrollHeight - element.clientHeight - element.scrollTop)}`,
    );
  } catch { /* diagnostics only */ }
}

type WheelLike = {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
  deltaY: number;
  deltaMode?: number;
};
type PointerLike = {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
  buttons?: number;
  clientX?: number;
  clientY?: number;
};
type TouchLike = {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
  touches: ArrayLike<{ clientY: number }>;
};

function normalizeWheelDelta(event: WheelLike): number {
  if (event.deltaMode === 1) return event.deltaY * 40;
  if (event.deltaMode === 2) return event.deltaY * event.currentTarget.clientHeight;
  return event.deltaY;
}

function boundaryTarget(root: HTMLElement, target: EventTarget | null): HTMLElement {
  const current = target instanceof Element ? target : null;
  const nested = current?.closest<HTMLElement>("[data-scrollable]");
  return nested && nested !== root ? nested : root;
}

function shouldMarkBoundaryGesture(
  target: HTMLElement,
  delta: number,
): boolean {
  return boundaryGestureReached(target, delta);
}

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.clientHeight - element.scrollTop;
}

function canScroll(element: HTMLElement): boolean {
  return element.scrollHeight - element.clientHeight > 1;
}

// The downward-arrival band scales with the pane: on a tall transcript a fast
// turn appends far more than 32px between the reader's last scroll frame and
// the scroll event that lands, so a fixed band left the reader detached right
// under the tail (user: 스크롤이 너무 자주 풀린다).
function reattachBand(element: HTMLElement): number {
  return Math.max(REATTACH_THRESHOLD_PX, Math.round(element.clientHeight * 0.12));
}

export interface TranscriptFollow {
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

  const publish = useCallback((next: boolean) => {
    followingRef.current = next;
    // The timeline anchor is part of the same decision, not a consequence of
    // the re-render that follows it.
    setAnchorBottomRef?.current?.(next);
    setFollowing((current) => (current === next ? current : next));
  }, [setAnchorBottomRef]);

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
    pointerGesture.current = undefined;
    pointerDragging.current = false;
    chromeScroll.current = false;
    const element = viewport.current;
    if (element) {
      try {
        lastTop.current = element.scrollTop;
        lastScrollHeight.current = element.scrollHeight;
        lastDistance.current = distanceFromBottom(element);
      } catch { /* layout only */ }
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
    pointerGesture.current = undefined;
    pointerDragging.current = false;
    chromeScroll.current = false;
  }, []);
  const hasGesture = useCallback(
    () => Date.now() - gestureAt.current < GESTURE_WINDOW_MS,
    [],
  );
  const markReaderMotion = useCallback(() => {
    readerMotionAt.current = Date.now();
  }, []);
  const hasReaderScroll = useCallback(
    () => hasGesture() || Date.now() - readerMotionAt.current < READER_SCROLL_IDLE_MS,
    [hasGesture],
  );
  const markProgrammaticScroll = useCallback((top: number, intended?: number) => {
    const time = Date.now();
    const queue = programmatic.current.filter(
      (entry) => time - entry.time < PROGRAMMATIC_WINDOW_MS,
    );
    queue.push({ top: Math.round(top), time });
    if (typeof intended === "number" && Number.isFinite(intended)) {
      queue.push({ top: Math.round(intended), time });
    }
    programmatic.current = queue.slice(-PROGRAMMATIC_MEMORY);
  }, []);

  const isProgrammatic = useCallback((element: HTMLElement) => {
    const time = Date.now();
    const queue = programmatic.current.filter(
      (entry) => time - entry.time < PROGRAMMATIC_WINDOW_MS,
    );
    programmatic.current = queue;
    if (!queue.length) return false;
    return programmaticWriteMatches({ writes: queue, top: element.scrollTop, now: time });
  }, []);

  const scrollToBottom = useCallback((force: boolean) => {
    const element = viewport.current;
    if (!element) return;
    if (force && !followingRef.current) publish(true);
    if (!force && !followingRef.current) return;
    if (distanceFromBottom(element) < 2) return;
    scrollToEndRef?.current?.("auto");
  }, [publish, scrollToEndRef, viewport]);

  const stop = useCallback((reason = "gesture", previousTop = 0) => {
    const element = viewport.current;
    if (!element) return;
    if (!canScroll(element)) {
      publish(true);
      return;
    }
    if (!followingRef.current) return;
    reportRelease(reason, element, previousTop);
    publish(false);
  }, [publish, viewport]);

  const pause = useCallback(() => stop("pause"), [stop]);

  const updateScrollState = useCallback((element: HTMLDivElement) => {
    const max = element.scrollHeight - element.clientHeight;
    const distance = max - element.scrollTop;
    const overflow = max > 1;
    const jump = overflow && distance > Math.max(400, element.clientHeight);
    setShowJump((current) => current === jump ? current : jump);
  }, []);

  const scheduleScrollState = useCallback((element: HTMLDivElement) => {
    scrollStateTarget.current = element;
    if (scrollStateFrame.current) return;
    scrollStateFrame.current = window.requestAnimationFrame(() => {
      scrollStateFrame.current = 0;
      const target = scrollStateTarget.current;
      scrollStateTarget.current = null;
      if (target) updateScrollState(target);
    });
  }, [updateScrollState]);

  const handleScroll = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    scheduleScrollState(element);
    const previousTop = lastTop.current;
    lastTop.current = element.scrollTop;
    const programmaticScroll = isProgrammatic(element);
    // A native reader ramp may outlive the initial 250ms gesture window.
    // Extend ownership only from real movement, never from a virtual-core
    // correction, so compensation resumes once wheel/inertia actually stops.
    if (element.scrollTop !== previousTop && !programmaticScroll && hasReaderScroll()) {
      markReaderMotion();
    }
    lastScrollHeight.current = element.scrollHeight;
    // A scroll event is the reader's (or the core's) position talking, not a
    // content mutation: it is exactly the snapshot the content observer needs.
    lastDistance.current = distanceFromBottom(element);
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
      // Re-attaching only flips the flag — it never writes scrollTop, so the
      // reader's offset is never rolled back; the tail is regained by the next
      // append instead of a jump.
      const distance = distanceFromBottom(element);
      if (!canScroll(element)
        || distance < BOTTOM_THRESHOLD_PX
        // A DOWNWARD arrival re-attaches from a wider band: while a turn
        // streams, the bottom keeps moving away between the reader's last
        // scroll frame and this handler, so the ten-pixel band alone could
        // never be met on the way back.
        || (element.scrollTop > previousTop && distance <= reattachBand(element))) {
        publish(true);
      }
      return;
    }
    // A content click must not open the gesture window: a stream wobble in
    // the next 250ms would then unlock follow (user: 스크립트 클릭하면
    // 오토스크롤·줄바꿈이 풀린다). Selection autoscroll is the exception —
    // pointerDragging is armed only after a real 4px drag.
    if (readerScrollShouldReleaseFollow({
      programmatic: programmaticScroll,
      chromePointer: chromeScroll.current,
      upwardMove: previousTop - element.scrollTop,
    })) {
      stop("scroll", previousTop);
    }
  }, [
    hasReaderScroll,
    isProgrammatic,
    markGesture,
    markReaderMotion,
    publish,
    scheduleScrollState,
    stop,
    viewport,
  ]);

  const handleWheel = useCallback((event: WheelLike) => {
    const root = event.currentTarget;
    const delta = normalizeWheelDelta(event);
    if (!delta) return;
    const target = boundaryTarget(root, event.target);
    // One boundary decision drives BOTH marks. Testing "is there any nested
    // scroller?" separately kept follow armed for an upward wheel at a nested
    // scroller's leading edge: the gesture was marked, the transcript scrolled
    // up by chaining, and the end anchor then fought the reader every frame.
    const transcriptReached = target === root || shouldMarkBoundaryGesture(target, delta);
    if (!transcriptReached) return;
    markGesture();
    // Wheel rule: an upward wheel is explicit intent
    // and releases immediately, however small it is. Re-attaching is the side
    // that carries the slack (reattachBand).
    if (wheelShouldReleaseFollow({ delta, transcriptReached })) {
      stop("wheel", lastTop.current);
    }
  }, [markGesture, stop]);

  const handlePointerDown = useCallback((event: PointerLike) => {
    const root = event.currentTarget;
    pointerDragging.current = false;
    chromeScroll.current = isTranscriptChromeTarget(root, event.target);
    if (chromeScroll.current) markGesture();
    pointerGesture.current = event.clientX === undefined || event.clientY === undefined
      ? undefined
      : { x: event.clientX, y: event.clientY };
  }, [markGesture]);

  const handlePointerMove = useCallback((event: PointerLike) => {
    if (event.buttons !== 1) return;
    const root = event.currentTarget;
    const start = pointerGesture.current;
    if (start && event.clientX !== undefined && event.clientY !== undefined
      && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= POINTER_DRAG_PX) {
      pointerDragging.current = true;
      pointerGesture.current = undefined;
    }
    if (!pointerDragging.current) return;
    if (!pointerShouldReleaseFollow({
      distance: distanceFromBottom(root),
      upwardMove: lastTop.current - root.scrollTop,
    })) return;
    markGesture();
    stop("selection", lastTop.current);
  }, [markGesture, stop]);

  const handlePointerUp = useCallback(() => {
    pointerDragging.current = false;
    pointerGesture.current = undefined;
    chromeScroll.current = false;
  }, []);

  const handleSelectionAutoScroll = useCallback((delta: number) => {
    if (!Number.isFinite(delta) || delta === 0) return;
    // Claim reader ownership before TranscriptList writes scrollTop so the
    // virtual end anchor cannot pull against that write in the same frame.
    markGesture();
    if (selectionAutoScrollShouldReleaseFollow(delta)) {
      stop("selection", lastTop.current);
    }
  }, [markGesture, stop]);

  const handleTouchStart = useCallback((event: TouchLike) => {
    touchGesture.current = event.touches[0]?.clientY;
  }, []);

  const handleTouchMove = useCallback((event: TouchLike) => {
    const next = event.touches[0]?.clientY;
    const previous = touchGesture.current;
    touchGesture.current = next;
    if (next === undefined || previous === undefined) return;
    const delta = previous - next;
    if (!delta) return;
    const target = boundaryTarget(event.currentTarget, event.target);
    const transcriptReached = target === event.currentTarget
      || shouldMarkBoundaryGesture(target, delta);
    if (transcriptReached) {
      markGesture();
      // Wheel intent releases synchronously before Chromium's first scroll
      // frame; touch must do the same. Keeping the end anchor alive until the
      // later scroll event lets row measurement and followOnAppend reverse the
      // finger's movement, producing the mobile up/down scrollbar shake.
      if (touchMoveShouldReleaseFollow({ delta, transcriptReached })) {
        stop("touch", lastTop.current);
      }
    }
  }, [markGesture, stop]);

  const handleTouchEnd = useCallback(() => {
    touchGesture.current = undefined;
  }, []);

  const handleInteraction = useCallback(() => {
    // Click and in-place selection are not scroll intent. Releasing here
    // unlocked wrap/follow whenever the reader copied a live script line.
  }, []);

  const handleKeyDown = useCallback((event: {
    key: string;
    target?: EventTarget | null;
    currentTarget?: HTMLDivElement;
  }) => {
    if (!SCROLL_KEYS.includes(event.key)) return;
    const root = event.currentTarget ?? viewport.current;
    if (!root || boundaryTarget(root, event.target ?? root) !== root) return;
    markGesture();
    if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
      stop("key", lastTop.current);
    }
  }, [markGesture, stop, viewport]);

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
      if (distanceFromBottom(root) < 2) {
        jumpPinSettled.current += 1;
        if (jumpPinSettled.current >= JUMP_PIN_SETTLE_FRAMES) {
          cancelJumpPin();
          return;
        }
      } else {
        jumpPinSettled.current = 0;
        scrollToEndRef?.current?.("auto");
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
  }, [
    cancelJumpPin,
    clearReaderGesture,
    publish,
    scheduleScrollState,
    scrollToBottom,
    startJumpPin,
    viewport,
  ]);
  // Session ENTRY only re-arms following; it must not write scrollTop. The
  // virtual timeline already resolves its end position (initialOffset +
  // scrollToEnd), and a raw `scrollTop = scrollHeight` here made entry carry
  // TWO scroll authorities aiming at different offsets — the multi-frame
  // jump/flicker on re-entering a session.
  const arm = useCallback(() => {
    // A pin from the previous session must not write into the new one.
    cancelJumpPin();
    publish(true);
    const element = viewport.current;
    if (element) scheduleScrollState(element);
  }, [cancelJumpPin, publish, scheduleScrollState, viewport]);

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
    if (typeof ResizeObserver !== "function") return undefined;
    let viewportHeight = Math.round(element.getBoundingClientRect().height);
    // Seed the growth baseline with the height already on screen so the first
    // observation cannot report the whole transcript as this commit's growth.
    lastScrollHeight.current = element.scrollHeight;
    lastDistance.current = distanceFromBottom(element);
    // A fresh observer delivers the CURRENT box of every target it starts
    // watching — that first callback is an attach report, not a mutation. This
    // effect re-runs on every follow flip, so writing on it re-pinned the tail
    // one frame after the reader had released it (user: 위로 올려도 다시
    // 내려온다). The attach delivery may only seed the baselines.
    let attachDelivery = true;
    const observer = new ResizeObserver(() => {
      const root = viewport.current;
      if (!root) return;
      scheduleScrollState(root);
      const height = Math.round(root.getBoundingClientRect().height);
      const viewportHeightChanged = height !== viewportHeight;
      viewportHeight = height;
      const growth = root.scrollHeight - lastScrollHeight.current;
      lastScrollHeight.current = root.scrollHeight;
      const distance = distanceFromBottom(root);
      // The pre-mutation snapshot: the distance left by the last event that
      // was NOT this content mutation.
      const distanceBefore = lastDistance.current;
      lastDistance.current = distance;
      // Auto-scroll rule: a transcript that no longer
      // OVERFLOWS holds no reading position, so it re-arms follow. The CONTENT
      // side of that rule is driven by the rows commit in Conversation, not by
      // a second observer here — virtual-core stays the only content-growth
      // scroll authority.
      if (!canScroll(root)) {
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
        if (isProgrammatic(root)) return;
        // Nor is a frame the reader is actively scrolling through: the wheel
        // that just released follow is still animating its notch.
        if (hasGesture()) return;
        if (grewWhileAtBottom({ distanceBefore, growth })) {
          publish(true);
          scrollToBottom(false);
        }
        return;
      }
      // A width-only viewport resize (pane sash / window edge drag) belongs to
      // the virtual timeline: its end anchor absorbs every rewrap delta
      // pre-paint. Writing scrollTop here too made two scroll authorities race
      // mid-drag — exactly the up/down bounce while narrowing.
      // Content growth while following is followOnAppend + wasAtEnd. A second
      // scrollToEnd here raced the core. Viewport height (composer/pane) is
      // the one change the core does not own.
      if (!viewportHeightChanged) return;
      // Mid-gesture height writes fight native motion: a touch fling colliding
      // with a URL-bar/keyboard/composer height step gets its offset
      // overwritten mid-ramp and visibly bounces up/down (mobile report).
      // Hold the pin until the gesture lands; the idle delivery then takes the
      // bottom in one write.
      if (hasGesture()) return;
      scrollToBottom(false);
    });
    // Virtual-core still owns append and measured-row anchoring; the guard
    // above keeps this observer silent for every growth the core follows on
    // its own. Watching the viewport as well re-pins a composer or
    // bottom-panel resize in the same pre-paint transaction.
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

  useEffect(() => () => {
    if (scrollStateFrame.current) window.cancelAnimationFrame(scrollStateFrame.current);
    if (jumpPinFrame.current) window.cancelAnimationFrame(jumpPinFrame.current);
  }, []);

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
