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
// A scroll that lands this close to the end, moving down with no reader
// gesture behind it, is the reader arriving: follow re-engages on the spot.
const REPIN_PX = 1;
// Within this distance of the end an upward scroll is never a leave (a clamp
// to a shrunken extent lands here), and a pinned resnap needs more than this.
const END_TOLERANCE_PX = 2;
// A wheel notch toward older rows vouches for the scrolls that follow it.
const WHEEL_UP_WINDOW_MS = 200;
// A key that scrolls up vouches for the scroll it causes, and keeps the end
// pin off while it lands.
export const KEY_UP_WINDOW_MS = 1_000;
// A lifted finger that left the transcript above the end vouches for the
// momentum scrolls that follow.
const TOUCH_END_WINDOW_MS = 2_500;
// A DOM mutation or a width change explains an upward scroll this long.
const MUTATION_WINDOW_MS = 400;
// Mutations right after a restore are the restore's own.
const RESTORE_QUIET_MS = 150;
// A scroll up smaller than this many device pixels after a zoom change is
// rounding, not a leave.
const DEVICE_PX_FLOOR = 0.75;
// The jump control needs the end this far below the viewport.
const JUMP_CONTROL_PX = 200;
// A press on the scrollbar is held open by the pointer release, which the
// native scrollbar does not always deliver (the pointer left the window mid
// drag). Past this the press no longer vouches for upward scrolls.
const CHROME_PRESS_MAX_MS = 15_000;
const EDITABLE_TARGET =
  'input,textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
// A finger that travels no more than this from where it landed is a tap.
const TOUCH_MOVED_PX = 4;
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
/** iOS WebKit: a touch scroll's held corrections land once its scroll stream
 *  (finger or momentum) has been quiet this long. iOS fires its last touch
 *  event as momentum starts, so quiet scroll events are the only end signal. */
export const IOS_TOUCH_SETTLE_MS = 150;
// A scroll event this soon after a write of the timeline's own is that write.
// Later events are the timeline's only when they land exactly on the value it
// last wrote (the first event after that write).
export const PROGRAMMATIC_WINDOW_MS = 150;
// Jump-to-latest must BEAT the motion it interrupts. Both this hook and the
// virtual timeline gate every end write on reader ownership, so a click that
// landed inside a live gesture window (wheel ramp, fling tail, scrollbar drag)
// was swallowed whole: the transcript kept coasting and the offset never moved
// (user: 스크롤 중에 최신으로 이동을 눌러도 즉시 멈추지 않는다). The jump
// therefore drops reader ownership first, then re-pins the tail frame by frame
// until the residual momentum Chromium still delivers is overwritten.
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

/** Is this wheel a vertical scroll? A pinch-zoom (ctrl) and a sideways swipe
 *  with a little vertical drift are not a move toward older rows. */
export function wheelIsVerticalScroll(event: { deltaY: number; deltaX?: number; ctrlKey?: boolean }): boolean {
  return !event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX ?? 0);
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

/** Does this wheel notch release follow? Only a vertical notch toward older
 *  rows over a transcript that has rows above its viewport, wherever in the
 *  transcript (a nested scroller included) it lands. */
export function wheelReleasesFollow(
  event: { deltaY: number; deltaX?: number; ctrlKey?: boolean },
  scrollTop: number
): boolean {
  return wheelIsVerticalScroll(event) && event.deltaY < 0 && scrollTop > 0;
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

/** Has the finger travelled beyond a tap from where it landed? */
export function touchTravelled(startY: number, y: number): boolean {
  return Math.abs(y - startY) > TOUCH_MOVED_PX;
}

/** Which of the timeline's own writes explains this scroll event? */
export function attributeWrite({
  lastWriteAt,
  writtenTops,
  top,
  now,
}: {
  /** When the timeline last wrote the offset; 0 before any write. */
  lastWriteAt: number;
  /** The offsets that write left (the target and where it landed). */
  writtenTops: readonly number[];
  top: number;
  now: number;
}): { recent: boolean; exact: boolean } {
  return {
    recent: lastWriteAt > 0 && now - lastWriteAt <= PROGRAMMATIC_WINDOW_MS,
    exact: writtenTops.includes(Math.round(top)),
  };
}

/** Is a mutation or width change fresh enough to explain an upward scroll, and
 *  not the aftermath of a restore of ours? */
export function mutationExplainsScroll({
  mutationAt,
  restoredAt,
  now,
}: {
  mutationAt: number;
  restoredAt: number;
  now: number;
}): boolean {
  return now - mutationAt < MUTATION_WINDOW_MS && mutationAt > restoredAt;
}

/** Was a mutation too close to the last restore to be counted? */
export function mutationIsOwnRestore({ restoredAt, now }: { restoredAt: number; now: number }): boolean {
  return now - restoredAt < RESTORE_QUIET_MS;
}

/** A container width change not yet answered by a restore: the client width is
 *  a new one and has not been spent on a restore already. */
export function widthShiftPending(seen: { client: number; spent: number | null } | null, clientWidth: number): boolean {
  return seen !== null && clientWidth !== seen.client && clientWidth !== seen.spent;
}

export type ScrollVerdict = 'pin' | 'unpin' | 'restore' | 'none';

/**
 * What one scroll observation means for follow.
 *
 * Arriving at the end re-engages follow at once; a pinned viewport that moved
 * up is a leave only when something corroborates it, and is otherwise put
 * back whenever the timeline's own write, a zoom change, or a fresh layout
 * change explains the move. A move nothing explains is a leave as well.
 */
export function judgeScrollEvent(input: {
  pinned: boolean;
  previousTop: number;
  top: number;
  /** Distance from the end after this move. */
  distance: number;
  /** Direction of the last move that changed the offset: 1 down, -1 up, 0 unknown. */
  lastDirection: number;
  touchDown: boolean;
  wheelUpRecent: boolean;
  /** This is a scroll event within the write window of the timeline's last write. */
  inWriteWindow: boolean;
  /** This scroll event is exactly the value the timeline last wrote. */
  atWrittenTop: boolean;
  /** A mouse press (scrollbar, selection drag) is held. */
  pressHeld: boolean;
  keyUpRecent: boolean;
  touchEndRecent: boolean;
  zoomChanged: boolean;
  /** Zoom factor now. */
  zoom: number;
  mutationRecent: boolean;
  widthShifted: boolean;
}): ScrollVerdict {
  const gesture = input.touchDown || input.wheelUpRecent;
  if (
    !gesture &&
    !input.inWriteWindow &&
    !input.atWrittenTop &&
    input.lastDirection > 0 &&
    input.distance <= REPIN_PX
  ) {
    return 'pin';
  }
  if (!input.pinned || !(input.top < input.previousTop) || input.distance <= END_TOLERANCE_PX) return 'none';
  const corroborated = gesture || input.pressHeld || input.keyUpRecent || input.touchEndRecent;
  if ((input.inWriteWindow || input.atWrittenTop) && !corroborated) return 'restore';
  if (corroborated) return 'unpin';
  if (input.zoomChanged && (input.previousTop - input.top) * input.zoom < DEVICE_PX_FLOOR) return 'restore';
  if (input.mutationRecent || input.widthShifted) return 'restore';
  return 'unpin';
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

const PRESS_INTERACTIVE =
  'a[href],button,summary,label,input,select,textarea,iframe,video,audio,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="radio"]';
const KEEPS_FOLLOW = '[data-transcript-keeps-follow]';

/** Does a press, or an Enter/Space, on this target let go of follow? Activating
 *  an interactive control (an expander, a link, a button) is about to change
 *  the content under the reader; prose, code text and chrome are not. */
export function activationReleasesFollow(root: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target === root || target.closest(KEEPS_FOLLOW)) return false;
  const control = target.closest(PRESS_INTERACTIVE);
  return control !== null && control !== root && root.contains(control);
}

/** Is this target an editable field? Enter and Space there are typing. */
export function editableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE_TARGET) !== null;
}

/** Is the tail far enough out of sight to offer the jump? Only when follow is
 *  off and the end is more than a short step below the viewport. */
export function jumpButtonVisible(metrics: ScrollMetrics, following: boolean): boolean {
  return !following && distanceFromBottom(metrics) > JUMP_CONTROL_PX;
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
  deltaX?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
};
export type PointerLike = {
  target: EventTarget | null;
  currentTarget: HTMLDivElement;
  button?: number;
  pointerType?: string;
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

export function canScroll(metrics: ScrollMetrics): boolean {
  return metrics.maxScrollTop > 1;
}
