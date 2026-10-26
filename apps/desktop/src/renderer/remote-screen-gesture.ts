// The boundary between the touch layer and the PC screen's input. The touch
// layer (remote-touch-gestures.ts with remote-viewport.ts) decides what a
// finger means and where on the PC picture it lands (the direct or trackpad
// strategy is the touch layer's, remote-screen-touch.ts); it reports abstract
// actions at absolute points in VIDEO pixels. This adapter is the only place
// they become `screen-pointer` / `screen-wheel` messages, and the only one
// that knows which button a drag holds.
import type { RemoteScreenButton, RemoteScreenInput } from '../shared/remote-webrtc';

export type ScreenPoint = { x: number; y: number };
/** How a finger maps to the PC: under the finger, or by moving a cursor. */
export type ScreenInputMode = 'direct' | 'trackpad';

/** What the touch layer reports, at points of the PC picture in video pixels. */
export type ScreenGestureAction =
  /** The pointer moved with no button held (the trackpad cursor). */
  | { type: 'pointer-move'; at: ScreenPoint }
  /** Press and lift `count` times at one point (1 by default). */
  | { type: 'tap'; at: ScreenPoint; button?: RemoteScreenButton; count?: 1 | 2 | 3 }
  /** A long press begins holding a button; moves follow, then end or cancel. */
  | { type: 'drag-start'; at: ScreenPoint; button?: RemoteScreenButton }
  | { type: 'drag-move'; at: ScreenPoint }
  | { type: 'drag-end'; at: ScreenPoint }
  /** The drag was interrupted (a second finger, the pane left, touchcancel). */
  | { type: 'drag-cancel' }
  /** WheelEvent-signed deltas in CSS-like pixels of the PC picture. */
  | { type: 'scroll'; at: ScreenPoint; dx: number; dy: number };

/** One wheel notch is 120 Windows units; a notch is about 100 picture pixels. */
export const SCREEN_WHEEL_UNITS_PER_PIXEL = 1.2;
/** The contract's bound: 40 notches. */
const MAX_WHEEL_UNITS = 120 * 40;

export interface ScreenGestureAdapterOptions {
  /** The locked video size: points are kept inside it. */
  size(): { width: number; height: number } | null;
}

const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value));
/** Whole Windows wheel units of `units`, toward zero and within the bound
 *  (immune to the float error of a product that should be an integer). */
const wheelUnits = (units: number): number =>
  Math.max(-MAX_WHEEL_UNITS, Math.min(MAX_WHEEL_UNITS, Math.trunc(units + Math.sign(units) * 1e-9)));

export function createScreenGestureAdapter(options: ScreenGestureAdapterOptions) {
  let held: { button: RemoteScreenButton; at: ScreenPoint } | null = null;
  /** Wheel units not yet sent: a slow swipe adds up instead of rounding away. */
  let carry = { x: 0, y: 0 };

  const inside = (point: ScreenPoint): ScreenPoint => {
    const size = options.size();
    return size ? { x: clamp(point.x, size.width), y: clamp(point.y, size.height) } : point;
  };
  const target = (at: ScreenPoint): ScreenPoint => inside(at);
  const press = (action: 'down' | 'up', button: RemoteScreenButton, at: ScreenPoint): RemoteScreenInput => ({
    type: 'screen-pointer',
    action,
    button,
    x: at.x,
    y: at.y,
  });

  /** An interrupted drag: the held button is lifted where it was pressed and
   *  `screen-release` lifts anything else this viewer holds on the PC. */
  const cancel = (): RemoteScreenInput[] => {
    if (!held) return [];
    const { button, at } = held;
    held = null;
    return [press('up', button, at), { type: 'screen-release' }];
  };

  return {
    /** True while a long-press drag holds a button. */
    get dragging(): boolean {
      return held !== null;
    },
    /** The messages one gesture action sends, in order. */
    screenInputFromGesture(action: ScreenGestureAction): RemoteScreenInput[] {
      switch (action.type) {
        case 'pointer-move': {
          const at = target(action.at);
          return [{ type: 'screen-pointer', action: 'move', x: at.x, y: at.y }];
        }
        case 'tap': {
          const at = target(action.at);
          const button = action.button ?? 'left';
          const inputs: RemoteScreenInput[] = [{ type: 'screen-pointer', action: 'move', x: at.x, y: at.y }];
          for (let index = 0; index < (action.count ?? 1); index += 1) {
            inputs.push(press('down', button, at), press('up', button, at));
          }
          return inputs;
        }
        case 'drag-start': {
          if (held) return [];
          const at = target(action.at);
          held = { button: action.button ?? 'left', at };
          return [{ type: 'screen-pointer', action: 'move', x: at.x, y: at.y }, press('down', held.button, at)];
        }
        case 'drag-move': {
          if (!held) return [];
          const at = target(action.at);
          held = { ...held, at };
          return [{ type: 'screen-pointer', action: 'move', x: at.x, y: at.y }];
        }
        case 'drag-end': {
          if (!held) return [];
          const at = target(action.at);
          const { button } = held;
          held = null;
          return [{ type: 'screen-pointer', action: 'move', x: at.x, y: at.y }, press('up', button, at)];
        }
        case 'drag-cancel':
          return cancel();
        case 'scroll': {
          const at = target(action.at);
          const x = carry.x + action.dx * SCREEN_WHEEL_UNITS_PER_PIXEL;
          const y = carry.y + action.dy * SCREEN_WHEEL_UNITS_PER_PIXEL;
          const deltaX = wheelUnits(x);
          const deltaY = wheelUnits(y);
          // What the bound cut off is dropped; what rounding left over is kept.
          carry = {
            x: Math.abs(x) > MAX_WHEEL_UNITS ? 0 : x - deltaX,
            y: Math.abs(y) > MAX_WHEEL_UNITS ? 0 : y - deltaY,
          };
          return deltaX || deltaY ? [{ type: 'screen-wheel', x: at.x, y: at.y, deltaX, deltaY }] : [];
        }
      }
    },
    cancel,
  };
}

export type ScreenGestureAdapter = ReturnType<typeof createScreenGestureAdapter>;
