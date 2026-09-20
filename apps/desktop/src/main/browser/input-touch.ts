/**
 * Touch gestures at image coordinates: a tap is one contact down and up, a
 * swipe drags a single contact across ten intermediate points. Points arrive
 * in image pixels and are divided by the page zoom into CSS pixels here.
 */
import type { WebContents } from 'electron';

import { cssPoint, type Point, type SendBrowserInput } from './input-primitives';

const SWIPE_STEPS = 10;

function touchPoint(zoom: number, x: number, y: number) {
  return {
    ...cssPoint({ x: x / zoom, y: y / zoom }),
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
    const zoom = guest.getZoomFactor();
    await touchEvent(guest, 'touchStart', [touchPoint(zoom, point.x, point.y)], signal);
    await touchEvent(guest, 'touchEnd', [], signal);
  }

  async function swipeAt(guest: WebContents, source: Point, destination: Point, signal?: AbortSignal): Promise<void> {
    const zoom = guest.getZoomFactor();
    await touchEvent(guest, 'touchStart', [touchPoint(zoom, source.x, source.y)], signal);
    for (let step = 0; step <= SWIPE_STEPS; step += 1) {
      await touchEvent(
        guest,
        'touchMove',
        [
          touchPoint(
            zoom,
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
