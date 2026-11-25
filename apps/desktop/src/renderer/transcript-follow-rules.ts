import { logTranscriptScroll } from './transcript-scroll-diagnostics';

export const GESTURE_WINDOW_MS = 250;
// Keep reader ownership alive between native wheel/touch/scrollbar frames.
// Unlike virtual-core's isScrolling this excludes the timeline's own writes,
// so late idle measurements can still compensate in a continuous burst.
export const READER_SCROLL_IDLE_MS = 180;
// A virtualized transcript must have exactly one geometry authority.
// Browser anchoring and virtual-core both compensate rows that resize above
// the viewport, so enabling both makes upward reader motion oscillate.
export const TRANSCRIPT_OVERFLOW_ANCHOR = 'none';
// Within this distance of the end an upward scroll is never a leave (a clamp
// to a shrunken extent lands here), and a pinned resnap needs more than this.
// A view this close is at the end: it follows, and past it the end is not kept
// and the jump control says so.
const END_TOLERANCE_PX = 2;
// A wheel notch toward older rows vouches for the scrolls that follow it.
const WHEEL_UP_WINDOW_MS = 200;
// A key that scrolls up vouches for the scroll it causes, and keeps the end
// pin off while it lands.
const KEY_UP_WINDOW_MS = 1_000;
// A lifted finger that left the transcript above the end vouches for the
// momentum scrolls that follow.
const TOUCH_END_WINDOW_MS = 2_500;
// A scroll moving down with no reader gesture behind it that ends this close to the end is the reader coming back:
// follow re-engages on the spot.
const JUMP_CONTROL_PX = 200;
// A press on the scrollbar is held open by the pointer release, which the
// native scrollbar does not always deliver (the pointer left the window mid
// drag). Past this the press no longer vouches for upward scrolls.
const CHROME_PRESS_MAX_MS = 15_000;
const EDITABLE_TARGET =
  'input,textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
// A finger that travels no more than this from where it landed is a tap.
const TOUCH_MOVED_PX = 4;
// A phone's fling outlasts the 250ms gesture and 180ms motion windows, so touch ownership latches on
// the touch and ends on scrollend; this idle is the fallback for engines without scrollend.
const TOUCH_FLING_IDLE_MS = 700;
/** iOS WebKit: a touch scroll's held corrections land once its scroll stream
 *  (finger or momentum) has been quiet this long. iOS fires its last touch
 *  event as momentum starts, so quiet scroll events are the only end signal. */
export const IOS_TOUCH_SETTLE_MS = 150;
// A jump drops reader ownership, then re-pins the tail each frame until Chromium's residual momentum is overwritten.
export const JUMP_PIN_MS = 400;
export const JUMP_PIN_SETTLE_FRAMES = 3;

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

/** Is this wheel a vertical scroll? A pinch-zoom (ctrl), a shift-wheel and a
 *  sideways swipe with a little vertical drift are not a move toward older rows. */
export function wheelIsVerticalScroll(event: {
  deltaY: number;
  deltaX?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): boolean {
  return !event.ctrlKey && !event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX ?? 0);
}

/** Does this keydown scroll the transcript up or down? A modified key is an
 *  app shortcut (a tab switch), except the platform's jump to the top; a key
 *  aimed at a field moves its caret instead. */
export function classifyScrollKey(event: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  target?: EventTarget | null;
}): 'up' | 'down' | 'none' {
  if ((event.ctrlKey || event.altKey || event.metaKey) && event.key !== 'ArrowUp' && event.key !== 'Home') {
    return 'none';
  }
  // Shift+Tab moves focus back up the page, and the browser scrolls it into view.
  if (event.key === 'Tab') return event.shiftKey ? 'up' : 'none';
  if (event.target != null && event.target instanceof Element && event.target.closest(EDITABLE_TARGET)) {
    return 'none';
  }
  switch (event.key) {
    case 'ArrowUp':
    case 'PageUp':
    case 'Home':
      return 'up';
    case 'ArrowDown':
    case 'PageDown':
    case 'End':
      return 'down';
    case ' ':
      return event.shiftKey ? 'up' : 'down';
    default:
      return 'none';
  }
}

/** Does a mouse press inside the transcript still vouch for a native upward
 *  scroll (a scrollbar drag, a selection drag autoscrolling)? `pressedAt` is 0
 *  when no press is open. */
export function chromePressHeld({ pressedAt, now }: { pressedAt: number; now: number }): boolean {
  return pressedAt > 0 && now - pressedAt < CHROME_PRESS_MAX_MS;
}

/** Does this press land on the scroller's scrollbar? The scroller's own padding targets it too, so only a press on the
 *  track its gutter reserves counts. */
export function pressOnScrollbar(root: Element, event: { target: EventTarget | null; clientX?: number }): boolean {
  if (event.target !== root || event.clientX === undefined) return false;
  const box = root as HTMLElement;
  const track = box.offsetWidth - box.clientWidth - box.clientLeft * 2;
  return track > 0 && root.getBoundingClientRect().right - event.clientX <= track;
}

/** Did a wheel notch toward older rows happen lately? */
export function wheelUpRecent({ wheelUpAt, now }: { wheelUpAt: number; now: number }): boolean {
  return wheelUpAt > 0 && now - wheelUpAt < WHEEL_UP_WINDOW_MS;
}

/** Is the up-key window open? A scroll up inside it is the key's. */
export function keyUpRecent({ keyUpAt, now }: { keyUpAt: number; now: number }): boolean {
  return keyUpAt > 0 && now - keyUpAt < KEY_UP_WINDOW_MS;
}

/** Did a finger lift lately from above the end? Its momentum scrolls are the reader's. */
export function touchEndRecent({ touchEndUpAt, now }: { touchEndUpAt: number; now: number }): boolean {
  return touchEndUpAt > 0 && now - touchEndUpAt < TOUCH_END_WINDOW_MS;
}

/** Has the finger travelled up or down beyond a tap from where it landed? A sideways swipe (pane traversal) has not. */
export function touchTravelled(start: { x?: number; y: number }, at: { x?: number; y: number }): boolean {
  const down = Math.abs(at.y - start.y);
  return down > TOUCH_MOVED_PX && down >= Math.abs((at.x ?? 0) - (start.x ?? 0));
}

/** Is this scroll event at an offset the timeline wrote since the last one (the target or where it landed)? */
export function atWrittenOffset(writtenTops: readonly number[], top: number): boolean {
  return writtenTops.includes(Math.round(top));
}

/** Does this move of the offset bring the reader back near the end: down, not onto an offset the timeline wrote, and
 *  ending where a scroll toward the end takes follow back? Content resizing or a write that brings the end near is
 *  not the reader coming back. */
export function moveArrivesNearEnd(move: {
  previousTop: number;
  top: number;
  distance: number;
  written: boolean;
}): boolean {
  return move.top > move.previousTop && !move.written && move.distance <= JUMP_CONTROL_PX;
}

type ScrollVerdict = 'pin' | 'unpin' | 'restore' | 'none';

/**
 * What one scroll observation means for follow.
 *
 * Only the reader leaves the end: a pinned viewport that moved up past the end tolerance is a leave when an upward
 * input of theirs is behind the move (a wheel notch, a key, a travelled finger or its fling, a dragged thumb, a
 * selection dragged above the view). An upward move nothing of theirs explains (a clamp to a shrunken extent, a
 * zoom's rounding) is never theirs: it is put back. A move down onto the band near the end that the timeline did not
 * write, with no input of theirs in flight, is the reader coming back.
 */
export function judgeScrollEvent(input: {
  pinned: boolean;
  previousTop: number;
  top: number;
  /** Distance from the end after this move. */
  distance: number;
  /** The last move that changed the offset was the reader's way back near the end (`moveArrivesNearEnd`). */
  arrived: boolean;
  /** An upward input of the reader's is behind this move. */
  upward: boolean;
  /** Input of the reader's is still in flight (a finger on the glass, a held thumb): it is judged when it ends. */
  inFlight: boolean;
  /** This scroll event is at an offset the timeline wrote since the last one. */
  atWrittenTop: boolean;
}): ScrollVerdict {
  if (
    !input.pinned &&
    !input.inFlight &&
    !input.upward &&
    !input.atWrittenTop &&
    input.arrived &&
    input.distance <= JUMP_CONTROL_PX
  ) {
    return 'pin';
  }
  if (!input.pinned || !(input.top < input.previousTop) || input.distance <= END_TOLERANCE_PX) return 'none';
  return input.upward ? 'unpin' : 'restore';
}

/** Does a finger lift need its own judgement of the scroll it ended? Only a
 *  lift after a scroll the timeline did not write, or after a travelled drag
 *  (or no timeline write at all) that moved the offset. */
export function touchLiftNeedsJudgement({
  scrolledNatively,
  moved,
  top,
  startTop,
  writesSinceStart,
}: {
  scrolledNatively: boolean;
  moved: boolean;
  top: number;
  startTop: number;
  writesSinceStart: boolean;
}): boolean {
  return scrolledNatively || (top !== startTop && (moved || !writesSinceStart));
}

/** Does a lift from above the end vouch for the momentum scrolls that follow? */
export function liftLeftAboveEnd({
  top,
  startTop,
  distance,
}: {
  top: number;
  startTop: number;
  distance: number;
}): boolean {
  return top < startTop && distance > END_TOLERANCE_PX;
}

/** Does the view stand at the end? */
export function standsAtEnd(metrics: ScrollMetrics): boolean {
  return distanceFromBottom(metrics) <= END_TOLERANCE_PX;
}

/** The jump control says the view is not kept at the end: it shows whenever the end is not kept (follow off, or held
 *  by a selection) and the view does not stand at it. */
export function jumpButtonVisible(metrics: ScrollMetrics, endKept: boolean): boolean {
  return !endKept && !standsAtEnd(metrics);
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

export function reportRelease(reason: string, metrics: ScrollMetrics, previousTop: number): void {
  logTranscriptScroll('follow-release', { reason, top: metrics.top, delta: metrics.top - previousTop });
  try {
    window.mixdogDesktop?.rendererDiagnostic?.({
      kind: 'follow-release',
      reason,
      top: metrics.top,
      delta: metrics.top - previousTop,
      distance: distanceFromBottom(metrics),
      windowFocused: document.hasFocus(),
      pageHidden: document.hidden,
    });
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

/** Follow taken back after a release: what took it and where the view stood. */
export function reportRearm(reason: string, metrics: ScrollMetrics): void {
  logTranscriptScroll('follow-rearm', { reason, top: metrics.top });
  try {
    window.mixdogDesktop?.rendererDiagnostic?.({
      kind: 'follow-rearm',
      reason,
      top: metrics.top,
      distance: distanceFromBottom(metrics),
    });
  } catch {
    /* diagnostics only */
  }
}

export type WheelLike = {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
  deltaY: number;
  deltaX?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
};
export type PointerLike = {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
  button?: number;
  pointerType?: string;
  clientX?: number;
};
export type TouchLike = {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
  touches: ArrayLike<{ clientY: number; clientX?: number }>;
};

export function normalizeWheelDelta(event: WheelLike): number {
  if (event.deltaMode === 1) return event.deltaY * 40;
  if (event.deltaMode === 2) return event.deltaY * event.currentTarget.clientHeight;
  return event.deltaY;
}

const SCROLLS = /^(auto|scroll|overlay)$/;
const CONTAINS_OVERSCROLL = /^(contain|none)$/;

/** The scroller inside the transcript that a gesture beginning over `target` reaches first: the innermost element
 *  between them that scrolls and has room to. Null when there is none. */
export type GestureScroller = { element: Element; contained: boolean } | null;

/** Read once, where the gesture begins: the browser latches a gesture to one scroller. */
export function gestureScroller(root: Element, target: EventTarget | null): GestureScroller {
  for (let node = target instanceof Element ? target : null; node && node !== root; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (!style || !SCROLLS.test(style.overflowY) || boundaryGestureReached(node, 0)) continue;
    return { element: node, contained: CONTAINS_OVERSCROLL.test(style.overscrollBehaviorY) };
  }
  return null;
}

/** Does the gesture's scroller take this vertical delta? It moves while it has room in the delta's direction, and one
 *  whose overscroll is contained keeps the delta at its edge too; whatever it does not take moves the transcript. */
export function scrollerTakes(scroller: GestureScroller, delta: number): boolean {
  return scroller !== null && (scroller.contained || !boundaryGestureReached(scroller.element, delta));
}

/** Scroll extent of a viewport owned by the virtual timeline, known without a
 *  layout read: the viewport height comes from a ResizeObserver and the
 *  content height from the virtual total size. */
interface TranscriptScrollGeometry {
  viewportHeight(): number;
  contentHeight(): number;
  /** Offset as last seen in a scroll event or written by the timeline. */
  scrollTop(): number;
  /** Logical offset minus the native scrollTop: a correction the timeline
   *  holds as a row offset while a touch scroll owns the viewport. */
  deviation?(): number;
  /** Lands nothing; a native write that targets a logical offset directly
   *  must drop the held row offset first. */
  dropDeviation?(): void;
}

const scrollGeometries = new WeakMap<Element, TranscriptScrollGeometry>();

/** Add to a native scrollTop for the timeline's logical offset. Programmatic
 *  write attribution stays native; reading position and extent are logical. */
export function transcriptScrollDeviation(element: Element): number {
  return scrollGeometries.get(element)?.deviation?.() ?? 0;
}

export function dropTranscriptScrollDeviation(element: Element): void {
  scrollGeometries.get(element)?.dropDeviation?.();
}

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
