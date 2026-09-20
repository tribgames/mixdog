/**
 * Pointer input at CSS coordinates: a click is move, press, release so the
 * page sees the hover state a real pointer produces first; hover and wheel
 * are single events.
 */
import type { WebContents } from 'electron';

import { type BrowserMouseButton, cssPoint, type Point, type SendBrowserInput } from './input-primitives';
import { measureBrowserMouseEvent } from './timing';

export function createMouseInput(send: SendBrowserInput) {
  async function clickAt(
    guest: WebContents,
    cssX: number,
    cssY: number,
    clickCount = 1,
    button: BrowserMouseButton = 'left',
    modifiers = 0,
    signal?: AbortSignal
  ): Promise<void> {
    const { x, y } = cssPoint({ x: cssX, y: cssY });
    const base = { x, y, button, clickCount, modifiers };
    if (
      (await measureBrowserMouseEvent('mouseMoved', () =>
        send(guest, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' }, signal)
      )) === 'dialog'
    )
      return;
    if (
      (await measureBrowserMouseEvent('mousePressed', () =>
        send(guest, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, signal)
      )) === 'dialog'
    )
      return;
    await measureBrowserMouseEvent('mouseReleased', () =>
      send(guest, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, signal)
    );
  }

  async function hoverAt(guest: WebContents, cssX: number, cssY: number, signal?: AbortSignal): Promise<void> {
    const point = cssPoint({ x: cssX, y: cssY });
    await send(
      guest,
      'Input.dispatchMouseEvent',
      {
        ...point,
        type: 'mouseMoved',
        button: 'none',
      },
      signal
    );
  }

  async function scrollAt(
    guest: WebContents,
    point: Point,
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal
  ): Promise<void> {
    await send(
      guest,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseWheel',
        ...cssPoint(point),
        deltaX,
        deltaY,
        button: 'none',
      },
      signal
    );
  }

  return { clickAt, hoverAt, scrollAt };
}
