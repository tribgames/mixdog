// Touch has no hover and no right button. Two consequences are corrected here,
// for touch input only (mouse and pen are never touched):
//
// - Tap through hidden controls. A tap first moves the emulated mouse, which
//   applies :hover, and the browser hit-tests again for the click. A control
//   that rests hidden and becomes clickable only under :hover (a row's archive
//   button) then takes a tap that began on its row. Such a click is returned to
//   the element the finger actually pressed.
// - Long-press is the right-click. Android may fire `contextmenu` itself, iOS
//   never does; whichever comes first opens the menu and the other is dropped.
import { DRAWER_COMMITTED_EVENT } from './drawer-intent';
import { TOUCH_LONG_PRESS_MS, TOUCH_SLOP_PX } from './remote-browser-touch';

/** The release after a menu opened lands its emulated mouse events on that
 *  menu; they still belong to the press. */
const RELEASE_WINDOW_MS = 800;
const CONTROL_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'label',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="option"]',
].join(', ');
/** Text fields keep the platform's own long-press (selection, paste). */
const EDITABLE_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

interface Press {
  id: number;
  origin: Element;
  x: number;
  y: number;
  timer: number;
  /** A context menu opened for this press (ours or the platform's). */
  opened: boolean;
  endedAt: number;
}

export function installTouchGestures(
  win: Window & typeof globalThis = window,
  longPressMs = TOUCH_LONG_PRESS_MS
): () => void {
  const doc = win.document;
  const own = new WeakSet<Event>();
  let press: Press | null = null;

  const stopTimer = (): void => {
    if (press?.timer) win.clearTimeout(press.timer);
    if (press) press.timer = 0;
  };
  const sameTouch = (event: Event): event is PointerEvent =>
    Boolean(press) &&
    (event as PointerEvent).pointerType === 'touch' &&
    (event as PointerEvent).pointerId === press?.id;
  /** The mouse events a touch press produces arrive after its pointerup. */
  const fromPress = (event: Event): boolean => {
    if (!press || own.has(event)) return false;
    const pointerType = (event as PointerEvent).pointerType;
    if (pointerType && pointerType !== 'touch') return false;
    return press.endedAt === 0 || Date.now() - press.endedAt < RELEASE_WINDOW_MS;
  };
  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const openMenu = (): void => {
    const current = press;
    if (!current) return;
    current.timer = 0;
    if (!current.origin.isConnected) return;
    const event = new win.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: current.x,
      clientY: current.y,
      button: 2,
      view: win,
    });
    own.add(event);
    current.origin.dispatchEvent(event);
    // Nothing handled it: the press keeps its native behavior.
    current.opened = event.defaultPrevented;
    if (current.opened) armScrollGuard();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    stopTimer();
    disarmScrollGuard();
    const origin = event.target instanceof win.Element ? event.target : null;
    // A second finger makes a pinch or a pan, never a press.
    if (!event.isPrimary || !origin) {
      press = null;
      return;
    }
    press = { id: event.pointerId, origin, x: event.clientX, y: event.clientY, timer: 0, opened: false, endedAt: 0 };
    if (!origin.closest(EDITABLE_SELECTOR)) press.timer = win.setTimeout(openMenu, longPressMs);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!sameTouch(event) || !press?.timer) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TOUCH_SLOP_PX) stopTimer();
  };
  const onPointerEnd = (event: PointerEvent): void => {
    if (!sameTouch(event) || !press) return;
    stopTimer();
    press.endedAt = Date.now();
    disarmScrollGuard();
  };
  // An open menu closes on scroll; the finger still resting on it must not scroll.
  const onTouchMove = (event: TouchEvent): void => {
    if (press?.opened && press.endedAt === 0 && event.cancelable) event.preventDefault();
  };
  // The guard is a NON-passive document touchmove listener, so it exists only
  // while a menu opened by the press is up. Registered for good, it made the
  // whole page a blocking touch region: every scroll's first move waited for
  // the main thread before the compositor could start it. The finger rests
  // (within the touch slop) until the menu opens, so its first move past the
  // slop is hit-tested against the region that now carries this listener.
  let scrollGuardArmed = false;
  const armScrollGuard = (): void => {
    if (scrollGuardArmed) return;
    scrollGuardArmed = true;
    doc.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  };
  const disarmScrollGuard = (): void => {
    if (!scrollGuardArmed) return;
    scrollGuardArmed = false;
    doc.removeEventListener('touchmove', onTouchMove, { capture: true });
  };
  const onContextMenu = (event: MouseEvent): void => {
    if (!fromPress(event) || !press) return;
    if (press.opened) {
      swallow(event);
      return;
    }
    // The platform recognized the long-press first: this is the press's menu.
    // Whether the app took it is known once the event finished dispatching.
    stopTimer();
    const current = press;
    current.opened = true;
    if (current.endedAt === 0) armScrollGuard();
    win.setTimeout(() => {
      current.opened = event.defaultPrevented;
      if (!current.opened && press === current) disarmScrollGuard();
    }, 0);
  };
  const onMouseButton = (event: MouseEvent): void => {
    if (press?.opened && fromPress(event)) swallow(event);
  };
  const onClick = (event: MouseEvent): void => {
    if (!fromPress(event) || !press) return;
    const current = press;
    press = null;
    if (current.opened) {
      swallow(event);
      return;
    }
    const target = event.target instanceof win.Element ? event.target : null;
    const control = target?.closest(CONTROL_SELECTOR);
    if (!control || control.contains(current.origin)) return;
    // The finger was on the control's box, yet the press did not hit it: it
    // was hidden then and became clickable during the tap. A control merely
    // NEAR the finger (the browser's touch target adjustment) stays clickable.
    const box = control.getBoundingClientRect();
    if (current.x < box.left || current.x > box.right || current.y < box.top || current.y > box.bottom) return;
    swallow(event);
    if (!current.origin.isConnected) return;
    const retarget = new win.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: event.clientX,
      clientY: event.clientY,
      detail: event.detail,
      view: win,
    });
    own.add(retarget);
    current.origin.dispatchEvent(retarget);
  };

  const listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions]> = [
    [doc, 'pointerdown', onPointerDown as EventListener, { capture: true }],
    [doc, 'pointermove', onPointerMove as EventListener, { capture: true, passive: true }],
    [doc, 'pointerup', onPointerEnd as EventListener, { capture: true }],
    [doc, 'pointercancel', onPointerEnd as EventListener, { capture: true }],
    [doc, 'contextmenu', onContextMenu as EventListener, { capture: true }],
    [doc, 'mousedown', onMouseButton as EventListener, { capture: true }],
    [doc, 'mouseup', onMouseButton as EventListener, { capture: true }],
    [doc, 'click', onClick as EventListener, { capture: true }],
  ];
  for (const [target, type, listener, options] of listeners) target.addEventListener(type, listener, options);
  return () => {
    stopTimer();
    disarmScrollGuard();
    press = null;
    for (const [target, type, listener, options] of listeners) target.removeEventListener(type, listener, options);
  };
}

// ── Edge swipes ─────────────────────────────────────────────────────────────
// A horizontal swipe from anywhere opens the drawer it moves toward: rightward
// the left one, leftward the right one. One openness value per drawer
// (0 closed … 1 open) follows the finger; the release snaps it to open or
// closed by fling velocity, else by distance. Everything that scrolls,
// selects or pages on its own keeps its horizontal drags.

/** Travel before a drag commits to horizontal (or is given up as vertical). */
const LOCK_PX = 10;
/** Release speed, in px/ms, that decides the snap on its own. */
const FLING_PX_PER_MS = 0.4;
const SAMPLE_WINDOW_MS = 100;
/** Inline end-state hold, so the snap animates before the class takes over. */
const SETTLE_HOLD_MS = 400;
const PHONE_MARKER = 'data-mixdog-mobile-tabs';
/** Surfaces that own horizontal drags: terminals, the browser pane, and
 *  dialogs over the page (the media viewer pages by swipe). */
const OWN_DRAG_SELECTOR = [
  '.dock-terminal',
  '.xterm',
  '.session-terminal-tab-panel',
  '.browser-remote-stage',
  '.browser-pane-content',
  '.studio-detail',
  '[role="dialog"]',
  '[role="slider"]',
  '[data-no-edge-swipe]',
].join(', ');

export interface DrawerControl {
  side: 'left' | 'right';
  isOpen(): boolean;
  setOpen(open: boolean): void;
  /** The sliding sheet; null while there is nothing to slide. */
  element(): HTMLElement | null;
  backdrop?(): HTMLElement | null;
}

interface Sample {
  v: number;
  t: number;
}

/** Signed speed (px/ms) over the most recent sample window. */
function velocityOf(samples: readonly Sample[]): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  const first = samples.find((sample) => last.t - sample.t <= SAMPLE_WINDOW_MS) ?? last;
  return last.t === first.t ? 0 : (last.v - first.v) / (last.t - first.t);
}

function pushSample(samples: Sample[], v: number, t: number): void {
  samples.push({ v, t });
  while (samples.length > 2 && t - (samples[0]?.t ?? t) > SAMPLE_WINDOW_MS * 3) samples.shift();
}

function scrollsHorizontally(win: Window, element: Element): boolean {
  if (element.scrollWidth <= element.clientWidth + 1) return false;
  const overflow = win.getComputedStyle(element).overflowX;
  return overflow === 'auto' || overflow === 'scroll';
}

/** True where a horizontal drag belongs to the content, not the drawers. */
function ownsHorizontalDrag(win: Window, start: Element): boolean {
  if (start.closest(OWN_DRAG_SELECTOR) || start.closest(EDITABLE_SELECTOR)) return true;
  const selection = win.getSelection?.();
  if (selection && !selection.isCollapsed && selection.toString() !== '') return true;
  const root = win.document.documentElement;
  for (let node: Element | null = start; node && node !== root; node = node.parentElement) {
    if (scrollsHorizontally(win, node)) return true;
  }
  return false;
}

/** True when the sheet's stylesheet names its rest transforms
 *  (07-mobile-chrome.css). Such a sheet is painted at an end with live
 *  `var()` references to them, so the inline paint always equals the current
 *  class target and dropping it starts no transition. */
const declaresRest = (win: Window, element: Element): boolean =>
  win.getComputedStyle(element).getPropertyValue('--mx-drawer-open-transform').trim() !== '';
interface Drag {
  id: number;
  x: number;
  y: number;
  /** Both null until a swipe with every drawer closed shows its direction. */
  drawer: DrawerControl | null;
  element: HTMLElement | null;
  /** The sheet names its rest transforms. */
  declaresRest: boolean;
  /** 1 when the drag began on an open drawer. */
  base: number;
  width: number;
  locked: boolean;
  position: number;
  samples: Sample[];
}

/** A drag that has its drawer and sheet. */
type BoundDrag = Drag & { drawer: DrawerControl; element: HTMLElement };
const isBound = (drag: Drag): drag is BoundDrag => drag.drawer !== null && drag.element !== null;

export interface EdgeSwipeOptions {
  now?: () => number;
  /** Dead band, in px, between each screen edge and its swipe band. A Safari
   *  tab owns the very edge for its back/forward swipe, so the band starts
   *  just inside it; an installed app has no such gesture and uses 0. */
  edgeInset?: number;
}

export function installEdgeSwipe(
  win: Window & typeof globalThis,
  drawers: readonly DrawerControl[],
  options: EdgeSwipeOptions = {}
): () => void {
  const doc = win.document;
  const edgeInset = options.edgeInset ?? 0;
  const now = options.now ?? (() => win.performance.now());
  let drag: Drag | null = null;
  let settleTimer = 0;
  /** The sheet and scrim carrying inline paint: dragged or still settling. */
  let painted: { element: HTMLElement; scrim: HTMLElement | null | undefined } | null = null;

  const sign = (drawer: DrawerControl): number => (drawer.side === 'left' ? 1 : -1);
  const paint = (current: BoundDrag, position: number, animate: boolean): void => {
    painted = { element: current.element, scrim: current.drawer.backdrop?.() };
    const shift = (1 - position) * 100 * -sign(current.drawer);
    const hidden = position <= 0;
    const sheet = current.element.style;
    sheet.transition = animate ? '' : 'none';
    const slid = `translateX(${shift}%)`;
    const rest = position >= 1 ? 'open' : position <= 0 ? 'closed' : null;
    sheet.transform = current.declaresRest && rest ? `var(--mx-drawer-${rest}-transform, ${slid})` : slid;
    sheet.visibility = animate && hidden ? 'hidden' : 'visible';
    const scrim = current.drawer.backdrop?.()?.style;
    if (scrim) {
      scrim.transition = animate ? '' : 'none';
      scrim.opacity = String(position);
      scrim.visibility = animate && hidden ? 'hidden' : 'visible';
    }
  };
  const clearPaint = (element: HTMLElement, scrim: HTMLElement | null | undefined): void => {
    for (const style of [element.style, scrim?.style]) {
      if (!style) continue;
      style.removeProperty('transition');
      style.removeProperty('transform');
      style.removeProperty('visibility');
      style.removeProperty('opacity');
    }
  };
  const clearLivePaint = (): void => {
    if (painted) clearPaint(painted.element, painted.scrim);
    painted = null;
  };
  // The commit that renders the drawer's new state reports itself on the sheet.
  // A paint at rest equals the class target, so it is handed over now instead
  // of at the end of the hold; one still gliding keeps it until the hold ends.
  const onCommitted = (event: Event): void => {
    if (!painted || drag || event.target !== painted.element) return;
    const gliding = painted.element
      .getAnimations()
      .some((animation) => (animation as CSSTransition).transitionProperty === 'transform' && animation.playState === 'running');
    if (gliding) return;
    win.clearTimeout(settleTimer);
    clearLivePaint();
  };
  const settle = (current: BoundDrag, open: boolean): void => {
    paint(current, open ? 1 : 0, true);
    if (open !== current.drawer.isOpen()) current.drawer.setOpen(open);
    win.clearTimeout(settleTimer);
    settleTimer = win.setTimeout(clearLivePaint, SETTLE_HOLD_MS);
  };

  /** The open drawer a drag may close, or (null) one it opens once its
   *  direction shows; null itself when the drag is not ours. */
  const pick = (x: number): { drawer: DrawerControl | null; base: number } | null => {
    const openDrawer = drawers.find((drawer) => drawer.isOpen());
    if (openDrawer) {
      // The right sheet covers the screen and is pushed back to the right from
      // anywhere on it (bind() rejects other directions); the browser keeps its edge.
      if (openDrawer.side === 'right' && x < edgeInset) return null;
      return { drawer: openDrawer, base: 1 };
    }
    // The dead band at each edge stays the browser's.
    if (x < edgeInset || x > win.innerWidth - edgeInset) return null;
    return { drawer: null, base: 0 };
  };

  /** Give an unbound drag the drawer its direction `dx` moves toward; false
   *  when there is none to slide. */
  const bind = (current: Drag, dx: number): current is BoundDrag => {
    if (isBound(current)) return true;
    const drawer = drawers.find((candidate) => candidate.side === (dx > 0 ? 'left' : 'right'));
    const element = drawer?.element();
    if (!drawer || !element) return false;
    current.drawer = drawer;
    current.element = element;
    current.declaresRest = declaresRest(win, element);
    current.width = element.getBoundingClientRect().width || win.innerWidth;
    return true;
  };

  // Touch events, not pointer events: when the browser claims a touch for a
  // pan it cancels the pointer but keeps delivering touch events, so the
  // drawer keeps following the finger over any content without an overlay on
  // the edge. They are passive and never swallow a tap.
  const tracked = (event: TouchEvent): Touch | undefined => {
    if (!drag) return undefined;
    const id = drag.id;
    return Array.from(event.changedTouches).find((touch) => touch.identifier === id);
  };
  const onDown = (event: TouchEvent): void => {
    // A second finger ends the drag: the sheet goes back where it started.
    const previous = drag;
    drag = null;
    if (previous?.locked && isBound(previous)) settle(previous, previous.base === 1);
    const touch = event.touches[0];
    if (!touch || event.touches.length > 1) return;
    if (!doc.documentElement.hasAttribute(PHONE_MARKER)) return;
    const picked = pick(touch.clientX);
    if (!picked) return;
    const element = picked.drawer ? picked.drawer.element() : null;
    if (picked.drawer && !element) return;
    const start = event.target instanceof win.Element ? event.target : null;
    if (!start || ownsHorizontalDrag(win, start)) return;
    win.clearTimeout(settleTimer);
    clearLivePaint();
    drag = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      drawer: picked.drawer,
      element,
      declaresRest: element ? declaresRest(win, element) : false,
      base: picked.base,
      width: element?.getBoundingClientRect().width || win.innerWidth,
      locked: false,
      position: picked.base,
      samples: [{ v: touch.clientX, t: now() }],
    };
  };
  const onMove = (event: TouchEvent): void => {
    const touch = tracked(event);
    if (!drag || !touch) return;
    const dx = touch.clientX - drag.x;
    const dy = touch.clientY - drag.y;
    const current = drag;
    if (!current.locked) {
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
      // Vertical, nothing to slide that way, or against the sheet's direction: not ours.
      // The vertical test runs first: bind() measures the sheet (a forced layout).
      const toward =
        Math.abs(dy) * 1.5 <= Math.abs(dx) &&
        bind(current, dx) &&
        (current.base === 0 ? dx * sign(current.drawer) > 0 : dx * sign(current.drawer) < 0);
      if (!toward) {
        drag = null;
        return;
      }
      current.locked = true;
    }
    if (!isBound(current)) return;
    const delta = (dx * sign(current.drawer)) / current.width;
    current.position = Math.min(1, Math.max(0, current.base + delta));
    pushSample(current.samples, touch.clientX, now());
    paint(current, current.position, false);
  };
  const onUp = (event: TouchEvent): void => {
    const current = drag;
    const touch = tracked(event);
    if (!current || !touch) return;
    drag = null;
    if (!current.locked || !isBound(current)) return;
    // The release is a sample too: a finger held still has no speed left.
    pushSample(current.samples, touch.clientX, now());
    const speed = velocityOf(current.samples) * sign(current.drawer);
    settle(current, Math.abs(speed) >= FLING_PX_PER_MS ? speed > 0 : current.position > 0.5);
  };
  // The platform took the gesture (its back swipe): put the sheet back.
  const onCancel = (event: TouchEvent): void => {
    const current = drag;
    if (!current || !tracked(event)) return;
    drag = null;
    if (current.locked && isBound(current)) settle(current, current.base === 1);
  };

  const listeners: Array<[string, EventListener]> = [
    ['touchstart', onDown as EventListener],
    ['touchmove', onMove as EventListener],
    ['touchend', onUp as EventListener],
    ['touchcancel', onCancel as EventListener],
  ];
  for (const [type, listener] of listeners) doc.addEventListener(type, listener, { capture: true, passive: true });
  doc.addEventListener(DRAWER_COMMITTED_EVENT, onCommitted);
  return () => {
    doc.removeEventListener(DRAWER_COMMITTED_EVENT, onCommitted);
    win.clearTimeout(settleTimer);
    drag = null;
    clearLivePaint();
    for (const [type, listener] of listeners) doc.removeEventListener(type, listener, { capture: true });
  };
}
// ── Flick to dismiss the keyboard ───────────────────────────────────────────
// A quick downward flick over the transcript puts the soft keyboard away.
// Touch events keep coming while the transcript scrolls.
const FLICK_SURFACE_SELECTOR = '.transcript';
/** Only the composer's own field gives up the keyboard. */
const COMPOSER_FIELD_SELECTOR = '.composer textarea';
const FLICK_MIN_PX = 30;
const FLICK_PX_PER_MS = 0.6;

export function installKeyboardFlick(
  win: Window & typeof globalThis,
  now: () => number = () => win.performance.now()
): () => void {
  const doc = win.document;
  let track: { x: number; y: number; samples: Sample[] } | null = null;

  const point = (event: TouchEvent): Touch | undefined => event.touches[0] ?? event.changedTouches[0];
  const onStart = (event: TouchEvent): void => {
    track = null;
    if (!doc.documentElement.hasAttribute(PHONE_MARKER)) return;
    const touch = point(event);
    const target = event.target instanceof win.Element ? event.target : null;
    if (!touch || event.touches.length > 1 || !target?.closest(FLICK_SURFACE_SELECTOR)) return;
    track = { x: touch.clientX, y: touch.clientY, samples: [{ v: touch.clientY, t: now() }] };
  };
  const onMove = (event: TouchEvent): void => {
    const touch = point(event);
    if (!track || !touch) return;
    pushSample(track.samples, touch.clientY, now());
    const dy = touch.clientY - track.y;
    const dx = touch.clientX - track.x;
    if (dy < FLICK_MIN_PX || dy < Math.abs(dx) * 2 || velocityOf(track.samples) < FLICK_PX_PER_MS) return;
    track = null;
    const active = doc.activeElement;
    if (active instanceof win.HTMLElement && active.matches(COMPOSER_FIELD_SELECTOR)) active.blur();
  };
  const onEnd = (): void => {
    track = null;
  };

  const listeners: Array<[string, EventListener]> = [
    ['touchstart', onStart as EventListener],
    ['touchmove', onMove as EventListener],
    ['touchend', onEnd],
    ['touchcancel', onEnd],
  ];
  for (const [type, listener] of listeners) doc.addEventListener(type, listener, { capture: true, passive: true });
  return () => {
    track = null;
    for (const [type, listener] of listeners) doc.removeEventListener(type, listener, { capture: true });
  };
}
