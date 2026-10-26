// The browser live view's touch → the page's mouse input, in page CSS px.
// The desktop pane keeps its own controller (createRemoteTouchController);
// the phone runs the shared gesture layer (createPhoneTouchController).
import type { DesktopBrowserPageAction } from '../shared/contract';
import {
  createTouchGestures,
  DOUBLE_TAP_TIMEOUT_MS,
  TOUCH_LONG_PRESS_MS,
  TOUCH_SLOP_PX,
  type TouchGestureAction,
  type TouchGestures,
} from './remote-touch-gestures';

export { DOUBLE_TAP_TIMEOUT_MS, TOUCH_LONG_PRESS_MS, TOUCH_SLOP_PX } from './remote-touch-gestures';
/** Android ViewConfiguration DOUBLE_TAP_SLOP (dp; a CSS pixel is a dp in an
 *  Android WebView at its default scale): the desktop pane's double tap that
 *  fits a zoomed picture. */
const FIT_DOUBLE_TAP_SLOP_PX = 100;

type Pointer = Extract<DesktopBrowserPageAction, { type: 'pointer' }>;
type Wheel = Extract<DesktopBrowserPageAction, { type: 'wheel' }>;
type Point = { x: number; y: number };

/** The desktop pane's touch → mouse: tap = left click, long-press = right
 * click, one-finger drag = left-button drag (slider CAPTCHAs), two-finger pan
 * = wheel. With `pinch`, two fingers spreading or closing zoom the local
 * picture instead (decided once per gesture), and a double tap on a zoomed
 * picture fits it again. Positions given to `page` are client pixels; `send`
 * receives page-space actions. */
export function createRemoteTouchController(options: {
  /** Client point → page CSS pixel, or null outside the picture. */
  page(x: number, y: number): Point | null;
  /** Client-pixel delta → page-pixel delta. */
  pageDelta(dx: number, dy: number): Point;
  send(action: Pointer | Wheel): void;
  /** Whether a one-finger drag pans the local zoomed picture instead. */
  panning(): boolean;
  pan(dx: number, dy: number): void;
  /** Local zoom by `scale` about client point (x, y), the fingers moved by (dx, dy). */
  pinch?(scale: number, x: number, y: number, dx: number, dy: number): void;
  /** Whether the local picture is at its fitted size. */
  fitted?(): boolean;
  fit?(): void;
  /** A press is about to reach the page (finish typing composition first). */
  press?(): void;
  indicator?(x: number, y: number): void;
  /** A tap was clicked into the page (inside its picture). */
  tapped?(): void;
  longPressMs?: number;
  now?(): number;
}) {
  type Touch = { x: number; y: number; startX: number; startY: number };
  const touches = new Map<number, Touch>();
  /** Every contact's position read in one event (`contacts`), since the set
   *  of contacts last changed; null until one arrives. */
  let snapshot: Point[] | null = null;
  /** This two-finger gesture's touch lists arrive: it moves only by them. */
  let snapshotSeen = false;
  /** Fingers whose pointer moved since the last touch list. A touch list
   *  follows each frame's pointer moves, so once every finger has reported
   *  and one reports again with no list between, the lists stopped (only a
   *  `touchstart` came). One finger's repeated reports alone may be batching. */
  const movedSinceSnapshot = new Set<number>();
  const now = options.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 'idle' until the gesture is decided; 'two' until two fingers are. */
  let mode: 'idle' | 'drag' | 'long' | 'pan' | 'two' | 'scroll' | 'pinch' | 'ended' = 'idle';
  let last: Point | null = null;
  let centroid: Point | null = null;
  let spread = 0;
  let lastTap: { at: number; x: number; y: number } | null = null;

  /** The contacts two-finger motion is read from: one event's snapshot, else
   *  the pointers' positions (when the set of contacts changes). */
  const positions = (): Point[] => snapshot ?? [...touches.values()];
  const spreadOf = (): number => {
    const [a, b] = positions();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const pointer = (phase: Pointer['phase'], at: Point, button: Pointer['button'], buttons: number): void => {
    last = at;
    options.send({ type: 'pointer', phase, ...at, button, buttons, modifiers: 0, clickCount: 1 });
  };
  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const release = (): void => {
    if (mode === 'drag' && last) pointer('mouseReleased', last, 'left', 0);
  };
  /** Two fingers decide once, from one snapshot of every finger: spreading
   *  or closing them more than moving them zooms; the scroll or zoom then
   *  starts from where the fingers began, losing nothing. */
  const classify = (): void => {
    if (mode !== 'two' || !centroid) return;
    const next = center();
    const spreadChange = Math.abs(spreadOf() - spread);
    const shift = Math.hypot(next.x - centroid.x, next.y - centroid.y);
    if (Math.max(spreadChange, shift) <= TOUCH_SLOP_PX) return;
    mode = spreadChange > shift ? 'pinch' : 'scroll';
    follow();
  };
  /** Pinch or scroll by the fingers' change since the last one applied. */
  const follow = (): void => {
    if (!centroid) return;
    const next = center();
    if (mode === 'pinch') {
      const nextSpread = spreadOf();
      if (spread > 0 && nextSpread > 0) {
        // Anchored where the fingers were: the page point under them there
        // moves with them to `next`.
        options.pinch?.(nextSpread / spread, centroid.x, centroid.y, next.x - centroid.x, next.y - centroid.y);
      }
      spread = nextSpread;
    } else if (next.x !== centroid.x || next.y !== centroid.y) {
      const origin = options.page(next.x, next.y);
      if (origin) {
        // Fingers moving up scroll the page down.
        const delta = options.pageDelta(centroid.x - next.x, centroid.y - next.y);
        options.send({ type: 'wheel', ...origin, deltaX: delta.x, deltaY: delta.y });
      }
    }
    centroid = next;
  };
  const center = (): Point => {
    const all = positions();
    return {
      x: all.reduce((sum, touch) => sum + touch.x, 0) / all.length,
      y: all.reduce((sum, touch) => sum + touch.y, 0) / all.length,
    };
  };

  return {
    down(id: number, x: number, y: number): void {
      touches.set(id, { x, y, startX: x, startY: y });
      snapshot = null;
      movedSinceSnapshot.clear();
      options.indicator?.(x, y);
      if (touches.size === 1) {
        mode = 'idle';
        snapshotSeen = false;
        const at = options.page(x, y);
        clearTimer();
        timer = setTimeout(() => {
          timer = null;
          if (mode !== 'idle' || !at) return;
          mode = 'long';
          options.press?.();
          pointer('mouseMoved', at, 'none', 0);
          pointer('mousePressed', at, 'right', 2);
          pointer('mouseReleased', at, 'right', 0);
        }, options.longPressMs ?? TOUCH_LONG_PRESS_MS);
        return;
      }
      clearTimer();
      release();
      mode = options.pinch ? 'two' : 'scroll';
      centroid = center();
      spread = spreadOf();
    },
    move(id: number, x: number, y: number): void {
      const touch = touches.get(id);
      if (!touch) return;
      touch.x = x;
      touch.y = y;
      if (mode === 'two' || mode === 'pinch' || mode === 'scroll') {
        // One pointer event carries one finger. A gesture whose touch lists
        // arrive moves only through `contacts`, which reads them all at once;
        // without them (no touch events) pointer reports scroll the page, and
        // never zoom, which partial reports cannot tell from a scroll. Both
        // move one shared centroid, so no motion is dispatched twice. Lists
        // that stop coming hand the gesture back to the pointer reports.
        if (snapshotSeen) {
          if (!movedSinceSnapshot.has(id) || movedSinceSnapshot.size < touches.size) {
            movedSinceSnapshot.add(id);
            return;
          }
          snapshotSeen = false;
          snapshot = null;
        }
        if (mode === 'pinch' || !centroid) return;
        if (mode === 'two') {
          const next = center();
          if (Math.hypot(next.x - centroid.x, next.y - centroid.y) <= TOUCH_SLOP_PX) return;
          mode = 'scroll';
        }
        follow();
        return;
      }
      if (touches.size !== 1) return;
      if (mode === 'idle' && Math.hypot(x - touch.startX, y - touch.startY) > TOUCH_SLOP_PX) {
        clearTimer();
        if (options.panning()) {
          mode = 'pan';
        } else {
          const start = options.page(touch.startX, touch.startY);
          if (!start) {
            mode = 'ended';
            return;
          }
          mode = 'drag';
          options.press?.();
          pointer('mouseMoved', start, 'none', 0);
          pointer('mousePressed', start, 'left', 1);
        }
      }
      if (mode === 'pan') {
        options.pan(x - touch.startX, y - touch.startY);
        touch.startX = x;
        touch.startY = y;
      } else if (mode === 'drag') {
        const at = options.page(x, y);
        if (at) pointer('mouseMoved', at, 'left', 1);
      }
    },
    up(id: number, x: number, y: number): void {
      const touch = touches.get(id);
      if (!touch) return;
      touches.delete(id);
      snapshot = null;
      if (mode === 'idle') {
        clearTimer();
        const at = options.page(x, y);
        const tappedAt = now();
        const double =
          lastTap !== null &&
          tappedAt - lastTap.at <= DOUBLE_TAP_TIMEOUT_MS &&
          Math.hypot(x - lastTap.x, y - lastTap.y) <= FIT_DOUBLE_TAP_SLOP_PX &&
          options.fitted?.() === false;
        if (double) {
          // Taps are never delayed to wait for a second one: the first tap
          // clicked; the second only fits the zoomed picture. A fitted
          // picture's double tap stays two clicks (the page's double-click).
          lastTap = null;
          options.fit?.();
        } else {
          lastTap = { at: tappedAt, x, y };
          if (at) {
            options.press?.();
            pointer('mouseMoved', at, 'none', 0);
            pointer('mousePressed', at, 'left', 1);
            pointer('mouseReleased', at, 'left', 0);
            options.tapped?.();
          }
        }
        mode = 'ended';
      } else if (mode === 'drag') {
        const at = options.page(x, y);
        if (at) pointer('mouseMoved', at, 'left', 1);
        release();
        mode = 'ended';
      }
      if (!touches.size) mode = 'idle';
      else if (mode === 'scroll') centroid = center();
      else if (mode === 'two' || mode === 'pinch') mode = 'ended';
    },
    cancel(id: number): void {
      if (!touches.delete(id)) return;
      snapshot = null;
      clearTimer();
      release();
      mode = touches.size ? 'ended' : 'idle';
    },
    /**
     * Every contact's current position, read in one event (a TouchEvent's
     * touches on the picture). Pointer events carry one finger each, and a
     * finger's report can arrive frames after another's, so two-finger
     * motion — the pinch-or-scroll decision included — is read only from
     * these synchronized snapshots, never from a partial set of reports. A
     * snapshot of another set of contacts than the pointers down is ignored.
     */
    contacts(points: Point[]): void {
      if (mode !== 'two' && mode !== 'pinch' && mode !== 'scroll') return;
      if (!points.length || points.length !== touches.size) return;
      snapshot = points.map(({ x, y }) => ({ x, y }));
      snapshotSeen = true;
      movedSinceSnapshot.clear();
      if (mode === 'two') classify();
      else follow();
    },
    dispose(): void {
      clearTimer();
      release();
      touches.clear();
      snapshot = null;
      mode = 'idle';
    },
  };
}

const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const;

/** The phone's touch → mouse, on the shared gesture layer (direct strategy):
 * tap = left click (1 finger), right click (2), middle click (3); long-press =
 * left button held, moving drags (slider CAPTCHAs), lifting releases;
 * one-finger drag pans the local view; two fingers swipe = wheel, or (with
 * `pinch`) pinch-zoom the local view, decided once per gesture. Positions
 * given to `page` are client pixels; `send` receives page-space actions. */
export function createPhoneTouchController(options: {
  /** Client point → page CSS pixel, or null outside the picture. */
  page(x: number, y: number): Point | null;
  /** Client-pixel delta → page-pixel delta. */
  pageDelta(dx: number, dy: number): Point;
  send(action: Pointer | Wheel): void;
  /** Move the local view by a client-pixel delta. */
  pan(dx: number, dy: number): void;
  /** Local zoom by `scale` about client point (x, y), the fingers moved by (dx, dy). */
  pinch?(scale: number, x: number, y: number, dx: number, dy: number): void;
  /** A press is about to reach the page (finish typing composition first). */
  press?(): void;
  /** Input reached the page here (client px): show a ring of `radius`. */
  indicator?(x: number, y: number, radius: number): void;
  /** A one-finger tap was clicked into the page (inside its picture). */
  tapped?(): void;
  /** The screen's client size: touches starting at its edges are ignored. */
  screen?(): { width: number; height: number };
  longPressMs?: number;
  now?(): number;
  requestFrame?(callback: () => void): unknown;
  cancelFrame?(handle: unknown): void;
}): TouchGestures {
  const pointer = (phase: Pointer['phase'], at: Point, button: Pointer['button'], buttons: number, clickCount = 1) =>
    options.send({ type: 'pointer', phase, x: at.x, y: at.y, button, buttons, modifiers: 0, clickCount });
  const emit = (action: TouchGestureAction): void => {
    switch (action.type) {
      case 'click':
        pointer('mouseMoved', action.at, 'none', 0);
        pointer('mousePressed', action.at, action.button, BUTTON_BITS[action.button], action.count);
        pointer('mouseReleased', action.at, action.button, 0, action.count);
        if (action.button === 'left') options.tapped?.();
        return;
      case 'press':
        pointer('mouseMoved', action.at, 'none', 0);
        pointer('mousePressed', action.at, 'left', 1);
        return;
      case 'drag':
        pointer('mouseMoved', action.at, 'left', 1);
        return;
      case 'release':
        pointer('mouseReleased', action.at, 'left', 0);
        return;
      case 'move':
        pointer('mouseMoved', action.at, 'none', 0);
        return;
      case 'wheel':
        options.send({ type: 'wheel', x: action.at.x, y: action.at.y, deltaX: action.deltaX, deltaY: action.deltaY });
        return;
      case 'feedback':
        options.indicator?.(action.x, action.y, action.radius);
        return;
    }
  };
  return createTouchGestures({
    strategy: 'direct',
    toTarget: options.page,
    toTargetDelta: options.pageDelta,
    pan: options.pan,
    zoom: options.pinch,
    emit,
    beforePress: options.press,
    screen: options.screen,
    longPressMs: options.longPressMs,
    now: options.now,
    requestFrame: options.requestFrame,
    cancelFrame: options.cancelFrame,
  });
}
