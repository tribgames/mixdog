// Chrome-mobile tab grammar for the projected phone surface: a horizontal
// swipe across the work area steps to the neighbouring tab, the way the
// desktop's arrow/Ctrl-Tab navigation does (user: 좌우 스와이프로 pc 컨트롤
// 방향키처럼). The gesture must stay out of the way of everything that
// legitimately scrolls sideways — terminals, editors, code blocks, tables —
// so both the decision rule and the opt-out surfaces live here and are
// testable without a DOM.

/** Minimum horizontal travel, in CSS px, before a drag counts as a swipe. */
export const SWIPE_MIN_DISTANCE = 60;
/** How much more horizontal than vertical the travel must be. A vertical
 *  scroll that drifts sideways must never steal a tab switch. */
export const SWIPE_AXIS_RATIO = 2;

export type SwipeIntent = "previous" | "next" | null;

/** Swiping LEFT (negative dx) reveals the tab to the right, matching phone
 *  browsers and the carousel metaphor of the pane strip. */
export function swipeIntent(
  deltaX: number,
  deltaY: number,
  {
    minDistance = SWIPE_MIN_DISTANCE,
    axisRatio = SWIPE_AXIS_RATIO,
  }: { minDistance?: number; axisRatio?: number } = {},
): SwipeIntent {
  const horizontal = Math.abs(deltaX);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null;
  if (horizontal < minDistance) return null;
  if (horizontal < Math.abs(deltaY) * axisRatio) return null;
  return deltaX < 0 ? "next" : "previous";
}

/** The tab a swipe lands on. Ends are hard stops rather than wraps: wrapping
 *  from the last tab to the first reads as a lost gesture on a phone. */
export function swipeTargetIndex(
  activeIndex: number,
  tabCount: number,
  intent: SwipeIntent,
): number {
  if (!intent || tabCount <= 1) return activeIndex;
  if (activeIndex < 0 || activeIndex >= tabCount) return activeIndex;
  const next = intent === "next" ? activeIndex + 1 : activeIndex - 1;
  return next < 0 || next >= tabCount ? activeIndex : next;
}

/** Surfaces that own horizontal gestures themselves. */
const SWIPE_OPT_OUT_SELECTOR = [
  ".xterm",
  ".monaco-editor",
  "pre",
  "table",
  "input",
  "textarea",
  "[data-swipe-ignore]",
  "[role='slider']",
].join(",");

export function swipeGestureAllowed(target: Element | null): boolean {
  if (!target) return true;
  if (target.closest(SWIPE_OPT_OUT_SELECTOR)) return false;
  // An element that can actually scroll sideways keeps its own gesture.
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollWidth - node.clientWidth > 8) {
      const overflowX = typeof getComputedStyle === "function"
        ? getComputedStyle(node).overflowX
        : "visible";
      if (overflowX === "auto" || overflowX === "scroll") return false;
    }
  }
  return true;
}
