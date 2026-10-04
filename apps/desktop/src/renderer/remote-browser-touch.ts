import type { DesktopBrowserPageAction } from '../shared/contract';

export const TOUCH_SLOP_PX = 9;
export const TOUCH_LONG_PRESS_MS = 500;

type Pointer = Extract<DesktopBrowserPageAction, { type: 'pointer' }>;
type Wheel = Extract<DesktopBrowserPageAction, { type: 'wheel' }>;
type Point = { x: number; y: number };

/** Touch → mouse: tap = left click, long-press = right click, one-finger drag =
 * left-button drag (slider CAPTCHAs), two-finger pan = wheel. Positions given
 * to `page` are client pixels; `send` receives page-space actions. */
export function createRemoteTouchController(options: {
  /** Client point → page CSS pixel, or null outside the picture. */
  page(x: number, y: number): Point | null;
  /** Client-pixel delta → page-pixel delta. */
  pageDelta(dx: number, dy: number): Point;
  send(action: Pointer | Wheel): void;
  /** Whether a one-finger drag pans the local zoomed picture instead. */
  panning(): boolean;
  pan(dx: number, dy: number): void;
  indicator?(x: number, y: number): void;
  longPressMs?: number;
}) {
  type Touch = { x: number; y: number; startX: number; startY: number };
  const touches = new Map<number, Touch>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 'idle' until the gesture is decided. */
  let mode: 'idle' | 'drag' | 'long' | 'pan' | 'scroll' | 'ended' = 'idle';
  let last: Point | null = null;
  let centroid: Point | null = null;

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
  const center = (): Point => {
    const all = [...touches.values()];
    return {
      x: all.reduce((sum, touch) => sum + touch.x, 0) / all.length,
      y: all.reduce((sum, touch) => sum + touch.y, 0) / all.length,
    };
  };

  return {
    down(id: number, x: number, y: number): void {
      touches.set(id, { x, y, startX: x, startY: y });
      options.indicator?.(x, y);
      if (touches.size === 1) {
        mode = 'idle';
        const at = options.page(x, y);
        clearTimer();
        timer = setTimeout(() => {
          timer = null;
          if (mode !== 'idle' || !at) return;
          mode = 'long';
          pointer('mouseMoved', at, 'none', 0);
          pointer('mousePressed', at, 'right', 2);
          pointer('mouseReleased', at, 'right', 0);
        }, options.longPressMs ?? TOUCH_LONG_PRESS_MS);
        return;
      }
      clearTimer();
      release();
      mode = 'scroll';
      centroid = center();
    },
    move(id: number, x: number, y: number): void {
      const touch = touches.get(id);
      if (!touch) return;
      touch.x = x;
      touch.y = y;
      if (mode === 'scroll') {
        const next = center();
        const origin = options.page(next.x, next.y);
        if (centroid && origin) {
          // Fingers moving up scroll the page down.
          const delta = options.pageDelta(centroid.x - next.x, centroid.y - next.y);
          options.send({ type: 'wheel', ...origin, deltaX: delta.x, deltaY: delta.y });
        }
        centroid = next;
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
      if (mode === 'idle') {
        clearTimer();
        const at = options.page(x, y);
        if (at) {
          pointer('mouseMoved', at, 'none', 0);
          pointer('mousePressed', at, 'left', 1);
          pointer('mouseReleased', at, 'left', 0);
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
    },
    cancel(id: number): void {
      if (!touches.delete(id)) return;
      clearTimer();
      release();
      mode = touches.size ? 'ended' : 'idle';
    },
    dispose(): void {
      clearTimer();
      release();
      touches.clear();
      mode = 'idle';
    },
  };
}
