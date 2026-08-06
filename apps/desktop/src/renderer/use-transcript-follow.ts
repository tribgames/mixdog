import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Transcript auto-scroll + session scroll-gesture grammar.
 *
 * The hook owns userScrolled, the 250ms gesture window, auto-write suppression,
 * the 10px return band, and the content ResizeObserver. TranscriptList owns
 * virtual row geometry, append following, and measured-size anchoring. No
 * pane-width or viewport observer adapter sits between those two owners.
 */
const GESTURE_WINDOW_MS = 250;
export const BOTTOM_THRESHOLD_PX = 10;
// Re-attaching tolerates more slack than releasing does: while a turn streams,
// the tail keeps moving away between the reader's last scroll frame and this
// handler, so a deliberate scroll back down lands tens of px above a bottom
// that has already grown.
const REATTACH_THRESHOLD_PX = 32;
const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
// A release must be a real upward move, not sub-pixel reflow noise. Fractional
// row heights under a parallel stream deliver 1px scrollTop wobble that is not
// reader intent; the reference implementation never sees it because it does not
// virtualize (user: 병렬 작업 중 타이핑하면 스크롤이 계속 풀린다).
const RELEASE_MOVE_PX = 1;

/**
 * Content-commit bottom rule, shared by all three reference implementations:
 * Claude Code (`render-node-to-output.ts`: `sticky || (grew && scrollTop >=
 * prevMaxScroll)`), opencode (`session.tsx`: `distance < 10 + max(0, delta)`)
 * and Codex (`pager_overlay.rs`: snapshot `is_scrolled_to_bottom()` BEFORE the
 * mutation, re-pin after). All three answer ONE question — was the viewport at
 * the bottom BEFORE this growth? — instead of measuring the distance after it
 * landed. Measuring after is what buried a turn that opens with a tool card and
 * no preamble: one commit grows the transcript by a whole card, so the 10px
 * band can never be met even though the reader never left the tail.
 */
export function atBottomBeforeGrowth({
  distance,
  growth,
  threshold = BOTTOM_THRESHOLD_PX,
}: {
  distance: number;
  growth: number;
  threshold?: number;
}): boolean {
  if (!Number.isFinite(distance) || !Number.isFinite(growth)) return false;
  if (growth < 0) return false;
  return distance < threshold + growth;
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
  const max = target.scrollHeight - target.clientHeight;
  if (max <= 1) return true;
  if (!delta) return false;
  if (delta < 0) return target.scrollTop + delta <= 0;
  return delta > max - target.scrollTop;
}

export function wheelConsumedByNestedScroller(
  target: EventTarget | null,
  boundary: HTMLElement,
  deltaY: number,
): boolean {
  const nested = boundaryTarget(boundary, target);
  return nested !== boundary && !shouldMarkBoundaryGesture(nested, deltaY);
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
}: {
  viewport: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  sessionKey: string;
  /** The timeline mounts only once its rows can be rendered for real, so the
   *  content observer has to re-attach when that mount finally happens. */
  contentMounted?: boolean;
}): TranscriptFollow {
  const [following, setFollowing] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const followingRef = useRef(true);
  const gestureAt = useRef(0);
  const touchGesture = useRef<number | undefined>(undefined);
  const auto = useRef<{ top: number; time: number } | undefined>(undefined);
  const autoTimer = useRef(0);
  const scrollStateFrame = useRef(0);
  const scrollStateTarget = useRef<HTMLDivElement | null>(null);
  // Offsets WRITTEN by the virtual timeline (append follow, measured-size
  // adjustments, entry anchoring) all route through its scrollToFn, which
  // reports them here. They are the timeline keeping its own promise, never
  // reader intent — counted as a gesture they released follow mid-stream
  // (user: 자동스크롤이 너무 자주 풀린다).
  const programmatic = useRef<{ tops: number[]; time: number } | undefined>(undefined);
  const programmaticTimer = useRef(0);
  // Last observed offset, so a release demands an actual UPWARD move.
  const lastTop = useRef(0);
  // Last observed content height, so a growth commit can be judged against the
  // bottom it had BEFORE that growth (see atBottomBeforeGrowth).
  const lastScrollHeight = useRef(0);

  const publish = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing((current) => (current === next ? current : next));
  }, []);

  const markGesture = useCallback(() => {
    gestureAt.current = Date.now();
  }, []);
  const hasGesture = useCallback(
    () => Date.now() - gestureAt.current < GESTURE_WINDOW_MS,
    [],
  );

  const markAuto = useCallback((element: HTMLElement) => {
    auto.current = {
      top: Math.max(0, element.scrollHeight - element.clientHeight),
      time: Date.now(),
    };
    window.clearTimeout(autoTimer.current);
    autoTimer.current = window.setTimeout(() => {
      auto.current = undefined;
      autoTimer.current = 0;
    }, 1_500);
  }, []);

  const isAuto = useCallback((element: HTMLElement) => {
    const value = auto.current;
    if (!value) return false;
    if (Date.now() - value.time > 1_500) {
      auto.current = undefined;
      return false;
    }
    return Math.abs(element.scrollTop - value.top) < 2;
  }, []);

  const markProgrammaticScroll = useCallback((top: number, intended?: number) => {
    const tops = [Math.round(top)];
    if (typeof intended === "number" && Number.isFinite(intended)) tops.push(Math.round(intended));
    programmatic.current = { tops, time: Date.now() };
    window.clearTimeout(programmaticTimer.current);
    programmaticTimer.current = window.setTimeout(() => {
      programmatic.current = undefined;
      programmaticTimer.current = 0;
    }, 1_500);
  }, []);

  const isProgrammatic = useCallback((element: HTMLElement) => {
    const value = programmatic.current;
    if (!value) return false;
    if (Date.now() - value.time > 1_500) {
      programmatic.current = undefined;
      return false;
    }
    const top = Math.round(element.scrollTop);
    return value.tops.some((candidate) => Math.abs(top - candidate) < 2);
  }, []);

  const scrollToBottomNow = useCallback((
    element: HTMLElement,
    behavior: ScrollBehavior,
  ) => {
    markAuto(element);
    if (behavior === "smooth") {
      element.scrollTo({ top: element.scrollHeight, behavior });
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [markAuto]);

  const scrollToBottom = useCallback((force: boolean) => {
    const element = viewport.current;
    if (!element) return;
    if (force && !followingRef.current) publish(true);
    if (!force && !followingRef.current) return;
    if (distanceFromBottom(element) < 2) {
      markAuto(element);
      return;
    }
    scrollToBottomNow(element, "auto");
  }, [markAuto, publish, scrollToBottomNow, viewport]);

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

  const handleAutoScroll = useCallback((previousTop: number): boolean => {
    const element = viewport.current;
    if (!element) return false;
    if (!canScroll(element)) {
      if (!followingRef.current) publish(true);
      return false;
    }
    if (distanceFromBottom(element) < BOTTOM_THRESHOLD_PX) {
      if (!followingRef.current) publish(true);
      return false;
    }
    if (followingRef.current && isAuto(element)) {
      scrollToBottom(false);
      return false;
    }
    // The timeline's own write is not a gesture, and neither is a scroll that
    // did not move UP: append-follow and reflow corrections keep the reader at
    // the tail, so only an actual upward move carries release intent.
    if (isProgrammatic(element)) return false;
    if (previousTop - element.scrollTop <= RELEASE_MOVE_PX) return false;
    stop("scroll", previousTop);
    return true;
  }, [isAuto, isProgrammatic, publish, scrollToBottom, stop, viewport]);

  const handleScroll = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    scheduleScrollState(element);
    const previousTop = lastTop.current;
    lastTop.current = element.scrollTop;
    lastScrollHeight.current = element.scrollHeight;
    // Re-attaching at the tail is NOT gesture-gated. Smooth-scroll and inertial
    // tails deliver their last frames well after the 250ms window closes, and a
    // streaming turn keeps pushing the bottom down, so requiring an open
    // gesture window here left a reader who scrolled back to the end detached
    // forever — new output then piled up below the fold (user: 내려도 다시 안
    // 붙고 텍스트가 아래로 묻힌다). Only the RELEASE decision needs gesture
    // attribution; a detached viewport cannot release again.
    if (!followingRef.current) {
      // The timeline's own corrective writes are not the reader coming back.
      if (isProgrammatic(element)) return;
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
    if (!hasGesture()) return;
    // Only a scroll actually attributed to the reader keeps the gesture window
    // alive; a stream of timeline writes must not hold it open forever.
    if (handleAutoScroll(previousTop)) markGesture();
  }, [
    handleAutoScroll,
    hasGesture,
    isProgrammatic,
    markGesture,
    publish,
    scheduleScrollState,
    viewport,
  ]);

  const handleWheel = useCallback((event: WheelLike) => {
    const root = event.currentTarget;
    const delta = normalizeWheelDelta(event);
    if (!delta) return;
    const target = boundaryTarget(root, event.target);
    if (target === root || shouldMarkBoundaryGesture(target, delta)) {
      markGesture();
    }
    const nested = event.target instanceof Element
      ? event.target.closest("[data-scrollable]")
      : null;
    // Wheel rule: an upward wheel is explicit intent
    // and releases immediately, however small it is. Re-attaching is the side
    // that carries the slack (reattachBand).
    if (delta < 0 && (!nested || nested === root)) stop("wheel", lastTop.current);
  }, [markGesture, stop]);

  const handlePointerDown = useCallback((event: PointerLike) => {
    if (boundaryTarget(event.currentTarget, event.target) === event.currentTarget) {
      markGesture();
    }
  }, [markGesture]);

  const handlePointerMove = useCallback((event: PointerLike) => {
    if (event.buttons !== 1) return;
    if (boundaryTarget(event.currentTarget, event.target) === event.currentTarget) {
      markGesture();
    }
  }, [markGesture]);

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
    if (target === event.currentTarget || shouldMarkBoundaryGesture(target, delta)) {
      markGesture();
    }
  }, [markGesture]);

  const handleTouchEnd = useCallback(() => {
    touchGesture.current = undefined;
  }, []);

  const handleInteraction = useCallback(() => {
    if (window.getSelection()?.toString()) stop("selection", lastTop.current);
  }, [stop]);

  const handleKeyDown = useCallback((event: {
    key: string;
    target?: EventTarget | null;
    currentTarget?: HTMLDivElement;
  }) => {
    if (!SCROLL_KEYS.includes(event.key)) return;
    const root = event.currentTarget ?? viewport.current;
    if (!root || boundaryTarget(root, event.target ?? root) !== root) return;
    markGesture();
  }, [markGesture, viewport]);

  const resume = useCallback(() => {
    publish(true);
    scrollToBottom(true);
    const element = viewport.current;
    if (element) scheduleScrollState(element);
  }, [publish, scheduleScrollState, scrollToBottom, viewport]);
  // Session ENTRY only re-arms following; it must not write scrollTop. The
  // virtual timeline already resolves its end position (initialOffset +
  // scrollToEnd), and a raw `scrollTop = scrollHeight` here made entry carry
  // TWO scroll authorities aiming at different offsets — the multi-frame
  // jump/flicker on re-entering a session.
  const arm = useCallback(() => {
    publish(true);
    const element = viewport.current;
    if (element) scheduleScrollState(element);
  }, [publish, scheduleScrollState, viewport]);

  useEffect(() => {
    const target = content.current;
    const element = viewport.current;
    if (!target || !element) return undefined;
    // Dynamic anchoring: while following, the virtual
    // timeline owns anchoring (overflow-anchor:none). Once the reader has left
    // the tail, browser auto-anchoring helps keep the reading position still
    // across rewrap/content mutations.
    element.style.overflowAnchor = followingRef.current ? "none" : "auto";
    // Chromium always provides ResizeObserver. The renderer's jsdom harness
    // intentionally omits it in tests that do not exercise layout delivery.
    if (typeof ResizeObserver !== "function") return undefined;
    let viewportHeight = Math.round(element.getBoundingClientRect().height);
    // Seed the growth baseline with the height already on screen so the first
    // observation cannot report the whole transcript as this commit's growth.
    lastScrollHeight.current = element.scrollHeight;
    const observer = new ResizeObserver(() => {
      const root = viewport.current;
      if (!root) return;
      scheduleScrollState(root);
      // Opencode parity (createAutoScroll): a transcript that no longer
      // OVERFLOWS holds no reading position, so it re-arms follow. The CONTENT
      // side of that rule is driven by the rows commit in Conversation, not by
      // a second observer here — virtual-core stays the only content-growth
      // scroll authority.
      if (!canScroll(root)) {
        if (!followingRef.current) publish(true);
        return;
      }
      const height = Math.round(root.getBoundingClientRect().height);
      const viewportHeightChanged = height !== viewportHeight;
      viewportHeight = height;
      const growth = root.scrollHeight - lastScrollHeight.current;
      lastScrollHeight.current = root.scrollHeight;
      const distance = distanceFromBottom(root);
      if (!followingRef.current) {
        // Reference parity (CC sticky restore, Codex `follow_bottom`): a commit
        // that GREW while the viewport still sat at the previous bottom means
        // the reader never left the tail, so the flag is restored and the new
        // bottom is taken. A turn that opens with a tool card and no preamble
        // lands its whole card in one commit, which is precisely the case the
        // after-the-fact 10px band could never recognise.
        if (!viewportHeightChanged && atBottomBeforeGrowth({ distance, growth })) {
          publish(true);
          scrollToBottom(false);
        }
        return;
      }
      // A width-only viewport resize (pane sash / window edge drag) belongs to
      // the virtual timeline: its end anchor absorbs every rewrap delta
      // pre-paint. Writing scrollTop here too made two scroll authorities race
      // mid-drag — exactly the up/down bounce while narrowing.
      // CONTENT growth is the other half of this rule. The streaming tail
      // grows inside its own selector-driven row, so no append and no rows
      // commit run while it does, and virtual-core re-pins only while the
      // offset sits inside its own end band: one tall row in a short split
      // pane leaves that band and the rest of the turn piles up below the fold
      // with follow still armed (user: 어시스턴트 턴에 자동 스크롤이 안 된다).
      // A timeline that KEPT its promise leaves the distance at zero, so this
      // re-pin writes nothing unless the tail was actually lost.
      if (!viewportHeightChanged && distance < BOTTOM_THRESHOLD_PX) return;
      scrollToBottom(false);
    });
    // Virtual-core still owns append and measured-row anchoring; the guard
    // above keeps this observer silent for every growth the core follows on
    // its own. Watching the viewport as well re-pins a composer or
    // bottom-panel resize in the same pre-paint transaction.
    observer.observe(element);
    observer.observe(target);
    return () => observer.disconnect();
  }, [content, contentMounted, following, publish, scheduleScrollState, scrollToBottom, sessionKey, viewport]);

  useEffect(() => () => {
    window.clearTimeout(autoTimer.current);
    window.clearTimeout(programmaticTimer.current);
    if (scrollStateFrame.current) window.cancelAnimationFrame(scrollStateFrame.current);
  }, []);

  return {
    following,
    followingRef,
    showJump,
    hasScrollGesture: hasGesture,
    handleScroll,
    handleWheel,
    handlePointerDown,
    handlePointerMove,
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
