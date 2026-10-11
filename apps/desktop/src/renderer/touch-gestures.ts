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
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    stopTimer();
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
  };
  // An open menu closes on scroll; the finger still resting on it must not scroll.
  const onTouchMove = (event: TouchEvent): void => {
    if (press?.opened && press.endedAt === 0 && event.cancelable) event.preventDefault();
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
    win.setTimeout(() => {
      current.opened = event.defaultPrevented;
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
    [doc, 'touchmove', onTouchMove as EventListener, { capture: true, passive: false }],
    [doc, 'contextmenu', onContextMenu as EventListener, { capture: true }],
    [doc, 'mousedown', onMouseButton as EventListener, { capture: true }],
    [doc, 'mouseup', onMouseButton as EventListener, { capture: true }],
    [doc, 'click', onClick as EventListener, { capture: true }],
  ];
  for (const [target, type, listener, options] of listeners) target.addEventListener(type, listener, options);
  return () => {
    stopTimer();
    press = null;
    for (const [target, type, listener, options] of listeners) target.removeEventListener(type, listener, options);
  };
}
