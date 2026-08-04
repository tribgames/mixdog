import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * React port of OpenCode's createAutoScroll + session scroll-gesture grammar.
 *
 * The hook owns userScrolled, the 250ms gesture window, auto-write suppression,
 * the 10px return band, and the content ResizeObserver. TranscriptList mirrors
 * OpenCode MessageTimeline and owns virtual row geometry, append following, and
 * measured-size anchoring. No pane-width or viewport observer adapter sits
 * between those two owners.
 */
const GESTURE_WINDOW_MS = 250;
const BOTTOM_THRESHOLD_PX = 10;
const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];

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
}

export function useTranscriptFollow({
  viewport,
  content,
  sessionKey,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  sessionKey: string;
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

  const stop = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    if (!canScroll(element)) {
      publish(true);
      return;
    }
    if (!followingRef.current) return;
    publish(false);
  }, [publish, viewport]);

  const pause = stop;

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

  const handleAutoScroll = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    if (!canScroll(element)) {
      if (!followingRef.current) publish(true);
      return;
    }
    if (distanceFromBottom(element) < BOTTOM_THRESHOLD_PX) {
      if (!followingRef.current) publish(true);
      return;
    }
    if (followingRef.current && isAuto(element)) {
      scrollToBottom(false);
      return;
    }
    stop();
  }, [isAuto, publish, scrollToBottom, stop, viewport]);

  const handleScroll = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    scheduleScrollState(element);
    if (!hasGesture()) return;
    handleAutoScroll();
    markGesture();
  }, [handleAutoScroll, hasGesture, markGesture, scheduleScrollState, viewport]);

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
    if (delta < 0 && (!nested || nested === root)) stop();
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
    if (window.getSelection()?.toString()) stop();
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

  useEffect(() => {
    const target = content.current;
    const element = viewport.current;
    if (!target || !element) return undefined;
    // OpenCode's virtual timeline is the sole browser-anchor authority.
    element.style.overflowAnchor = "none";
    // Chromium always provides ResizeObserver. The renderer's jsdom harness
    // intentionally omits it in tests that do not exercise layout delivery.
    if (typeof ResizeObserver !== "function") return undefined;
    let viewportHeight = Math.round(element.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const root = viewport.current;
      if (!root) return;
      scheduleScrollState(root);
      const contentResized = entries.some((entry) => entry.target !== root);
      const height = Math.round(root.getBoundingClientRect().height);
      const viewportHeightChanged = height !== viewportHeight;
      viewportHeight = height;
      if (!canScroll(root)) {
        if (!followingRef.current) publish(true);
        return;
      }
      if (!followingRef.current) return;
      // A width-only viewport resize (pane sash / window edge drag) belongs to
      // the virtual timeline: its end anchor absorbs every rewrap delta
      // pre-paint. Writing scrollTop here too made two scroll authorities race
      // mid-drag — exactly the up/down bounce while narrowing.
      if (!contentResized && !viewportHeightChanged) return;
      scrollToBottom(false);
    });
    observer.observe(target);
    // OpenCode's prompt dock never shrinks its ScrollView, so createAutoScroll
    // only watches content. Mixdog's composer/bottom-panel stack DOES shrink
    // this viewport (a dock drag changes clientHeight with no content resize),
    // so the same callback watches the viewport too — the bottom re-pins in
    // the same pre-paint ResizeObserver transaction.
    if (element !== target) observer.observe(element);
    return () => observer.disconnect();
  }, [content, publish, scheduleScrollState, scrollToBottom, sessionKey, viewport]);

  useEffect(() => () => {
    window.clearTimeout(autoTimer.current);
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
  };
}
