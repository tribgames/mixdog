// The touch layer on the PC screen's stage: finger events → remote-touch-
// gestures.ts (direct or trackpad strategy, over the viewport store) →
// abstract actions in video pixels → `ScreenGestureAction`s for the adapter in
// remote-screen-gesture.ts, which makes the screen-* messages.
import type { ScreenGestureAction, ScreenInputMode, ScreenPoint } from './remote-screen-gesture';
import {
  createTouchGestures,
  viewportGestureBindings,
  type CursorStore,
  type TouchGestureAction,
  type ViewportStore,
} from './remote-touch-gestures';

/** One touch action as the adapter's action, or null when it sends nothing
 *  (a feedback ring is drawn, not sent). A `click` with `count` 2 is the
 *  second click of a double-click: one more press and lift at the same point,
 *  which the PC pairs with the first by time and place. */
export function screenGestureFromTouch(action: TouchGestureAction): ScreenGestureAction | null {
  switch (action.type) {
    case 'click':
      return { type: 'tap', at: action.at, button: action.button, count: 1 };
    case 'press':
      return { type: 'drag-start', at: action.at };
    case 'drag':
      return { type: 'drag-move', at: action.at };
    case 'release':
      return { type: 'drag-end', at: action.at };
    case 'move':
      return { type: 'pointer-move', at: action.at };
    case 'wheel':
      return { type: 'scroll', at: action.at, dx: action.deltaX, dy: action.deltaY };
    case 'feedback':
      return null;
  }
}

/** The trackpad cursor in video pixels. It is this phone's own while a touch
 *  moves it; a touch's start takes the PC's report in (the PC cursor moved by
 *  its own mouse, or is somewhere this phone has not been), which is settled
 *  by then, unlike mid-drag when the report lags what was sent. The own
 *  cursor is kept only while `stamp()` is unchanged: a new geometry, session,
 *  secure desktop or stop makes its video pixels meaningless. */
export function createScreenCursorStore(
  pc: () => ScreenPoint | null,
  stamp: () => string = () => ''
): CursorStore & { sync(): void } {
  let local: { point: ScreenPoint; stamp: string } | null = null;
  const own = (): ScreenPoint | null => {
    if (local && local.stamp !== stamp()) local = null;
    return local?.point ?? null;
  };
  return {
    get: () => own() ?? pc(),
    set(point) {
      local = { point: { x: point.x, y: point.y }, stamp: stamp() };
    },
    sync() {
      const reported = pc();
      if (reported) local = { point: reported, stamp: stamp() };
      else own();
    },
  };
}

export interface ScreenTouchBinding {
  stage: HTMLElement;
  /** The strategy: 'direct' puts input under the finger. */
  mode: ScreenInputMode;
  viewport: ViewportStore;
  cursor: CursorStore & { sync(): void };
  /** One action to send; the pane's gate decides whether it goes. */
  send(action: ScreenGestureAction): void;
  /** A feedback ring at a point of the stage, in stage px. */
  ring(x: number, y: number, radius: number): void;
}

/** Wires finger events on the stage to the touch gestures; returns the disposer.
 *  The touch layer never focuses a field: a touch on the picture is cancelled
 *  (no synthesized mouse events, no focus change) and nothing here can open
 *  the soft keyboard. */
export function bindScreenTouch(binding: ScreenTouchBinding): () => void {
  const { stage } = binding;
  const bindings = viewportGestureBindings(binding.viewport, binding.mode === 'trackpad' ? binding.cursor : undefined);
  const gestures = createTouchGestures({
    ...bindings,
    strategy: binding.mode,
    screen: () => ({ width: window.innerWidth, height: window.innerHeight }),
    emit(action) {
      if (action.type === 'feedback') {
        const origin = binding.viewport.origin();
        binding.ring(action.x - origin.x, action.y - origin.y, action.radius);
        return;
      }
      const next = screenGestureFromTouch(action);
      if (next) binding.send(next);
    },
  });
  let down = 0;
  const each = (event: TouchEvent, apply: (touch: Touch) => void): void => {
    for (const touch of Array.from(event.changedTouches)) apply(touch);
  };
  const snapshot = (event: TouchEvent): void =>
    gestures.contacts(Array.from(event.touches, (touch) => ({ x: touch.clientX, y: touch.clientY })));
  const onStart = (event: TouchEvent): void => {
    event.preventDefault();
    if (down === 0) binding.cursor.sync();
    each(event, (touch) => {
      down += 1;
      gestures.down(touch.identifier, touch.clientX, touch.clientY);
    });
  };
  const onMove = (event: TouchEvent): void => {
    event.preventDefault();
    each(event, (touch) => gestures.move(touch.identifier, touch.clientX, touch.clientY));
    snapshot(event);
  };
  const onEnd = (event: TouchEvent): void => {
    event.preventDefault();
    each(event, (touch) => {
      down = Math.max(0, down - 1);
      gestures.up(touch.identifier, touch.clientX, touch.clientY);
    });
  };
  const onCancel = (event: TouchEvent): void => {
    each(event, (touch) => {
      down = Math.max(0, down - 1);
      gestures.cancel(touch.identifier);
    });
  };
  stage.addEventListener('touchstart', onStart, { passive: false });
  stage.addEventListener('touchmove', onMove, { passive: false });
  stage.addEventListener('touchend', onEnd, { passive: false });
  stage.addEventListener('touchcancel', onCancel);
  return () => {
    stage.removeEventListener('touchstart', onStart);
    stage.removeEventListener('touchmove', onMove);
    stage.removeEventListener('touchend', onEnd);
    stage.removeEventListener('touchcancel', onCancel);
    // Lifts a long-press drag still holding a button.
    gestures.dispose();
  };
}
