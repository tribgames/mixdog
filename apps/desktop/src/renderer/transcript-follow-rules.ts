export const GESTURE_WINDOW_MS = 250;
// Keep reader ownership alive between native wheel/touch/scrollbar frames.
// Unlike virtual-core's isScrolling this excludes the timeline's own writes,
// so late idle measurements can still compensate in a continuous burst.
export const READER_SCROLL_IDLE_MS = 180;
const BOTTOM_THRESHOLD_PX = 10;
// A virtualized transcript must have exactly one geometry authority.
// Browser anchoring and virtual-core both compensate rows that resize above
// the viewport, so enabling both makes upward reader motion oscillate.
export const TRANSCRIPT_OVERFLOW_ANCHOR = 'none';
// Re-attaching tolerates more slack than releasing does: while a turn streams,
// the tail keeps moving away between the reader's last scroll frame and this
// handler, so a deliberate scroll back down lands tens of px above a bottom
// that has already grown.
const REATTACH_THRESHOLD_PX = 32;
export const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
// A release must be a real upward move, not sub-pixel reflow noise. Fractional
// row heights under a parallel stream deliver 1px scrollTop wobble that is not
// reader intent; a plain scroll listener never sees it because it does not
// virtualize (user: 병렬 작업 중 타이핑하면 스크롤이 계속 풀린다).
const RELEASE_MOVE_PX = 1;
export const POINTER_DRAG_PX = 4;
// Touch ownership cannot be a timer. A phone keeps flinging for a second or
// more after the finger leaves, and a single slow markdown/tool frame on that
// phone outlives the 250ms gesture window and the 180ms motion window. The
// corrections that were being deferred then land in the middle of Chromium's
// momentum, which re-bases the fling and shakes the transcript up and down
// (user: 모바일에서 위로 스크롤하면 덜덜거린다). Ownership therefore latches
// on the touch itself, is held while the finger is down, and is closed by the
// browser's own scrollend — this idle is only the fallback for engines that do
// not fire it.
const TOUCH_FLING_IDLE_MS = 700;
// Programmatic writes arrive in BURSTS: one measurement commit can move the
// offset several times (core adjustment, spacer growth, end re-pin) before a
// single scroll event lands. Remembering only the last one made every earlier
// write in the burst read as reader intent.
export const PROGRAMMATIC_WINDOW_MS = 1_500;
export const PROGRAMMATIC_MEMORY = 12;
// Jump-to-latest must BEAT the motion it interrupts. Both this hook and the
// virtual timeline gate every end write on reader ownership, so a click that
// landed inside a live gesture window (wheel ramp, fling tail, scrollbar drag)
// was swallowed whole: the transcript kept coasting and the offset never moved
// (user: 스크롤 중에 최신으로 이동을 눌러도 즉시 멈추지 않는다). The jump
// therefore drops reader ownership first, then re-pins the tail frame by frame
// until the residual momentum Chromium still delivers is overwritten.
export const JUMP_PIN_MS = 400;
export const JUMP_PIN_SETTLE_FRAMES = 3;

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
export function isTranscriptChromeTarget(root: EventTarget | null, target: EventTarget | null): boolean {
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

/** Is a touch scroll still in flight? A finger on the glass owns the viewport
 *  outright; once it lifts, the fling keeps that ownership until scrollend
 *  closes the latch or the scroll stream itself goes quiet. */
export function touchScrollLatchOpen({
  latched,
  touchDown,
  sinceScrollMs,
  idleMs = TOUCH_FLING_IDLE_MS,
}: {
  /** A touch drag that actually moved the transcript has been seen. */
  latched: boolean;
  touchDown: boolean;
  /** Time since the last scroll frame of this touch scroll. */
  sinceScrollMs: number;
  idleMs?: number;
}): boolean {
  if (!latched) return false;
  if (touchDown) return true;
  return Number.isFinite(sinceScrollMs) && sinceScrollMs < idleMs;
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
  delta: number
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
  return writes.some((entry) => now - entry.time < windowMs && Math.abs(rounded - entry.top) < 2);
}

export function reportRelease(reason: string, metrics: ScrollMetrics, previousTop: number): void {
  try {
    window.mixdogDesktop?.perfLog?.(
      `transcript-follow-release reason=${reason}` +
        ` top=${Math.round(metrics.top)}` +
        ` delta=${Math.round(metrics.top - previousTop)}` +
        ` distance=${Math.round(distanceFromBottom(metrics))}`
    );
  } catch {
    /* diagnostics only */
  }
}

export type WheelLike = {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
  deltaY: number;
  deltaMode?: number;
};
export type PointerLike = {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
  buttons?: number;
  clientX?: number;
  clientY?: number;
};
export type TouchLike = {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
  touches: ArrayLike<{ clientY: number }>;
};

export function normalizeWheelDelta(event: WheelLike): number {
  if (event.deltaMode === 1) return event.deltaY * 40;
  if (event.deltaMode === 2) return event.deltaY * event.currentTarget.clientHeight;
  return event.deltaY;
}

export function boundaryTarget(root: HTMLElement, target: EventTarget | null): HTMLElement {
  const current = target instanceof Element ? target : null;
  const nested = current?.closest<HTMLElement>('[data-scrollable]');
  return nested && nested !== root ? nested : root;
}

/** Scroll extent of a viewport owned by the virtual timeline, known without a
 *  layout read: the viewport height comes from a ResizeObserver and the
 *  content height from the virtual total size. */
interface TranscriptScrollGeometry {
  viewportHeight(): number;
  contentHeight(): number;
  /** Offset as last seen in a scroll event or written by the timeline. */
  scrollTop(): number;
}

const scrollGeometries = new WeakMap<Element, TranscriptScrollGeometry>();

export function registerTranscriptScrollGeometry(viewport: Element, geometry: TranscriptScrollGeometry): () => void {
  scrollGeometries.set(viewport, geometry);
  return () => {
    if (scrollGeometries.get(viewport) === geometry) scrollGeometries.delete(viewport);
  };
}

/** Whether a mounted timeline answers for this viewport's geometry. */
export function transcriptScrollGeometryRegistered(element: Element): boolean {
  return scrollGeometries.has(element);
}

/** Reading scrollHeight/clientHeight on every scroll event or animation frame
 *  forced a synchronous layout of the whole list; a registered timeline
 *  answers from its own geometry. Anything else still asks the DOM. */
export function transcriptScrollExtent(
  element: HTMLElement,
  observedViewportHeight?: number
): { viewportHeight: number; maxScrollTop: number } {
  const geometry = scrollGeometries.get(element);
  const viewportHeight = observedViewportHeight ?? (geometry ? geometry.viewportHeight() : element.clientHeight);
  const contentHeight = geometry ? geometry.contentHeight() : element.scrollHeight;
  return { viewportHeight, maxScrollTop: Math.max(0, contentHeight - viewportHeight) };
}

interface ScrollMetrics {
  top: number;
  viewportHeight: number;
  maxScrollTop: number;
}

/** Offset and extent. Outside a scroll event (which passes the offset it just
 *  read) the timeline's cached offset stands in: an animation frame or
 *  observer callback runs after React commits, where a scrollTop read forced
 *  a layout of the whole list. */
export function transcriptScrollPosition(
  element: HTMLElement,
  observedViewportHeight?: number,
  observedTop?: number
): ScrollMetrics {
  const geometry = scrollGeometries.get(element);
  const extent = transcriptScrollExtent(element, observedViewportHeight);
  const top =
    observedTop ?? (geometry ? Math.min(Math.max(0, geometry.scrollTop()), extent.maxScrollTop) : element.scrollTop);
  return { top, ...extent };
}

export const scrollMetrics = transcriptScrollPosition;

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.maxScrollTop - metrics.top;
}

export function canScroll(metrics: ScrollMetrics): boolean {
  return metrics.maxScrollTop > 1;
}

// The downward-arrival band scales with the pane: on a tall transcript a fast
// turn appends far more than 32px between the reader's last scroll frame and
// the scroll event that lands, so a fixed band left the reader detached right
// under the tail (user: 스크롤이 너무 자주 풀린다).
function reattachBand(metrics: ScrollMetrics): number {
  return Math.max(REATTACH_THRESHOLD_PX, Math.round(metrics.viewportHeight * 0.12));
}

/** Has the viewport arrived back at the tail? A transcript that no longer
 *  overflows holds no reading position at all, the ten-pixel band IS the
 *  bottom, and a DOWNWARD arrival is judged against the wider band: while a
 *  turn streams, the bottom keeps moving away between the reader's last scroll
 *  frame and the handler, so the narrow band could never be met on the way
 *  back. Re-attaching only flips the flag; nothing here writes scrollTop. */
export function scrollShouldReattachFollow(metrics: ScrollMetrics, previousTop: number): boolean {
  if (!canScroll(metrics)) return true;
  const distance = distanceFromBottom(metrics);
  // An upward frame is the reader leaving: the first smooth-scroll frame of
  // the wheel notch that just released follow still lands inside the band,
  // and re-attaching there kept follow armed for the whole climb, so the next
  // resize (a card opening, the side panel) yanked the reader to the bottom.
  if (metrics.top < previousTop) return false;
  if (distance < BOTTOM_THRESHOLD_PX) return true;
  return metrics.top > previousTop && distance <= reattachBand(metrics);
}

/** Is the tail far enough out of sight to offer the jump? One viewport, and
 *  never less than 400px, on a transcript that actually overflows. */
export function jumpButtonVisible(metrics: ScrollMetrics): boolean {
  if (!canScroll(metrics)) return false;
  return distanceFromBottom(metrics) > Math.max(400, metrics.viewportHeight);
}
