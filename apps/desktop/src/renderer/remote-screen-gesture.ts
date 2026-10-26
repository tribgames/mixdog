// The boundary between the touch layer and the PC screen's input. The touch
// layer (remote-touch-gestures.ts with remote-viewport.ts) decides what a
// finger means and where on the PC picture it lands; it reports abstract
// actions in VIDEO pixels. This adapter is the only place they become
// `screen-pointer` / `screen-wheel` messages, in the direct or trackpad
// strategy, and the only one that knows which button a drag holds.
import type { RemoteScreenButton, RemoteScreenInput } from '../shared/remote-webrtc';

export type ScreenPoint = { x: number; y: number };
export type ScreenInputMode = 'direct' | 'trackpad';

/** What the touch layer reports. `at` is a point of the PC picture in video
 *  pixels (direct mode); trackpad mode acts at the cursor and ignores it. */
export type ScreenGestureAction =
  /** Hover without a button (a finger drag in direct mode; never sent in trackpad). */
  | { type: 'pointer-move'; at: ScreenPoint }
  /** Trackpad: the cursor moves by this many video pixels. */
  | { type: 'pointer-delta'; dx: number; dy: number }
  /** Press and lift; `count` 2 is a double click. */
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
  /** Trackpad mode's cursor on the PC picture, when the PC reports it.
   *  Without one the adapter follows the cursor it has itself moved. */
  cursor?(): ScreenPoint | null;
  mode?: ScreenInputMode;
}

const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value));
const wheelUnits = (pixels: number): number =>
  Math.max(-MAX_WHEEL_UNITS, Math.min(MAX_WHEEL_UNITS, Math.round(pixels * SCREEN_WHEEL_UNITS_PER_PIXEL)));

export function createScreenGestureAdapter(options: ScreenGestureAdapterOptions) {
  let mode: ScreenInputMode = options.mode ?? 'direct';
  /** The cursor this adapter last moved (trackpad, no PC cursor source). */
  let moved: ScreenPoint | null = null;
  let held: { button: RemoteScreenButton; at: ScreenPoint } | null = null;

  const inside = (point: ScreenPoint): ScreenPoint => {
    const size = options.size();
    return size ? { x: clamp(point.x, size.width), y: clamp(point.y, size.height) } : point;
  };
  /** Where the action lands: the point itself, or the trackpad cursor. */
  const target = (at: ScreenPoint | null): ScreenPoint | null => {
    if (mode === 'direct') return at ? inside(at) : null;
    const known = options.cursor?.() ?? moved;
    if (known) return inside(known);
    const size = options.size();
    return size ? { x: size.width / 2, y: size.height / 2 } : null;
  };
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
    get mode(): ScreenInputMode {
      return mode;
    },
    /** Switching strategy never leaves a button held. */
    setMode(next: ScreenInputMode): RemoteScreenInput[] {
      if (next === mode) return [];
      mode = next;
      return cancel();
    },
    /** True while a long-press drag holds a button. */
    get dragging(): boolean {
      return held !== null;
    },
    /** The messages one gesture action sends, in order. */
    screenInputFromGesture(action: ScreenGestureAction): RemoteScreenInput[] {
      switch (action.type) {
        case 'pointer-move': {
          if (mode !== 'direct') return [];
          const at = target(action.at);
          return at ? [{ type: 'screen-pointer', action: 'move', x: at.x, y: at.y }] : [];
        }
        case 'pointer-delta': {
          if (mode !== 'trackpad') return [];
          const from = target(null);
          if (!from) return [];
          moved = inside({ x: from.x + action.dx, y: from.y + action.dy });
          return [{ type: 'screen-pointer', action: 'move', x: moved.x, y: moved.y }];
        }
        case 'tap': {
          const at = target(action.at);
          if (!at) return [];
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
          if (!at) return [];
          held = { button: action.button ?? 'left', at };
          return [{ type: 'screen-pointer', action: 'move', x: at.x, y: at.y }, press('down', held.button, at)];
        }
        case 'drag-move': {
          if (!held) return [];
          const at = target(action.at);
          if (!at) return [];
          held = { ...held, at };
          return [{ type: 'screen-pointer', action: 'move', x: at.x, y: at.y }];
        }
        case 'drag-end': {
          if (!held) return [];
          const at = target(action.at) ?? held.at;
          const { button } = held;
          held = null;
          return [{ type: 'screen-pointer', action: 'move', x: at.x, y: at.y }, press('up', button, at)];
        }
        case 'drag-cancel':
          return cancel();
        case 'scroll': {
          const at = target(action.at);
          if (!at) return [];
          const deltaX = wheelUnits(action.dx);
          const deltaY = wheelUnits(action.dy);
          return deltaX || deltaY ? [{ type: 'screen-wheel', x: at.x, y: at.y, deltaX, deltaY }] : [];
        }
      }
    },
    cancel,
  };
}

export type ScreenGestureAdapter = ReturnType<typeof createScreenGestureAdapter>;
