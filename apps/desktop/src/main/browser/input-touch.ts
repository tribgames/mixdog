/**
 * Touch gestures at CSS coordinates: a tap is one contact down and up, a
 * swipe drags a single contact across ten intermediate points. CDP places a
 * touch point in the same CSS pixels as a mouse event, so page zoom never
 * rescales it here.
 */
import type { WebContents } from 'electron';

import { cssPoint, type Point, type SendBrowserInput } from './input-primitives';

const SWIPE_STEPS = 10;

function touchPoint(x: number, y: number) {
  return {
    ...cssPoint({ x, y }),
    radiusX: 1,
    radiusY: 1,
    force: 1,
    id: 0,
  };
}

export function createTouchInput(send: SendBrowserInput) {
  const touchEvent = (
    guest: WebContents,
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    touchPoints: ReturnType<typeof touchPoint>[],
    signal?: AbortSignal
  ) => send(guest, 'Input.dispatchTouchEvent', { type, touchPoints }, signal);

  async function tapAt(guest: WebContents, point: Point, signal?: AbortSignal): Promise<void> {
    await touchEvent(guest, 'touchStart', [touchPoint(point.x, point.y)], signal);
    await touchEvent(guest, 'touchEnd', [], signal);
  }

  async function swipeAt(guest: WebContents, source: Point, destination: Point, signal?: AbortSignal): Promise<void> {
    await touchEvent(guest, 'touchStart', [touchPoint(source.x, source.y)], signal);
    for (let step = 0; step <= SWIPE_STEPS; step += 1) {
      await touchEvent(
        guest,
        'touchMove',
        [
          touchPoint(
            source.x + ((destination.x - source.x) * step) / SWIPE_STEPS,
            source.y + ((destination.y - source.y) * step) / SWIPE_STEPS
          ),
        ],
        signal
      );
    }
    await touchEvent(guest, 'touchEnd', [], signal);
  }

  return { tapAt, swipeAt };
}
