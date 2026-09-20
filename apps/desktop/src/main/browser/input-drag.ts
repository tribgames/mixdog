/**
 * Drag gestures. A page that answers a press-and-move with its own HTML5 drag
 * never sees the rest of the mouse gesture: Chromium hands the drag payload
 * to the host and then waits for drag events. Without that exchange a Kanban
 * card or a file drop zone ignores the whole gesture, so the driver arms
 * interception, watches for the payload, and finishes as a drop. A page that
 * drags with plain mouse handlers stays on the mouse path.
 */
import type { WebContents } from 'electron';

import { cssPoint, type Point, type SendBrowserInput } from './input-primitives';

/** Intermediate moves of one drag: enough for a page that tracks movement,
 *  few enough to stay one quick gesture. */
const DRAG_STEPS = 8;
const DRAG_INTERCEPT_POLLS = 5;
const DRAG_INTERCEPT_POLL_MS = 20;
/** Dropping a file copies it into the page; it never moves or links it. */
const DRAG_OPERATION_COPY = 1;

/** What Chromium hands over when it intercepts a page's own drag: the items
 *  the page put on the drag, plus the operations it allows. */
export interface BrowserDragData {
  items: Array<Record<string, unknown>>;
  files?: string[];
  dragOperationsMask: number;
}

/** The host's view of an intercepted drag. The driver never reads page state
 *  itself; it only asks whether this gesture turned into a native drag. */
export interface BrowserDragInterception {
  /** Forget a payload left by an earlier gesture. */
  reset(guest: WebContents): void;
  /** Take the payload this gesture produced, if Chromium delivered one. */
  take(guest: WebContents): BrowserDragData | null;
}

/** Where one gesture stands: the payload Chromium intercepted, if any, and
 *  whether the page has already been told the drag entered it. */
interface DragGesture {
  data: BrowserDragData | null;
  entered: boolean;
}

async function waitForInterceptedDrag(
  guest: WebContents,
  drags: BrowserDragInterception | undefined,
  signal?: AbortSignal
): Promise<BrowserDragData | null> {
  if (!drags) return null;
  for (let attempt = 0; attempt < DRAG_INTERCEPT_POLLS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, DRAG_INTERCEPT_POLL_MS));
    signal?.throwIfAborted();
    const data = drags.take(guest);
    if (data) return data;
  }
  return null;
}

export function createDragInput(send: SendBrowserInput, options: { drags?: BrowserDragInterception }) {
  const mouseEvent = (guest: WebContents, params: Record<string, unknown>, signal?: AbortSignal) =>
    send(guest, 'Input.dispatchMouseEvent', params, signal);
  const dragEvent = (guest: WebContents, type: string, point: Point, data: BrowserDragData, signal?: AbortSignal) =>
    send(guest, 'Input.dispatchDragEvent', { ...point, type, data }, signal);

  /** Move from `start` to `end` in steps; the moment Chromium hands over a
   *  payload the gesture switches from mouse moves to drag events. */
  async function dragThrough(
    guest: WebContents,
    start: Point,
    end: Point,
    drags: BrowserDragInterception | undefined,
    signal?: AbortSignal
  ): Promise<DragGesture | 'dialog'> {
    const gesture: DragGesture = { data: null, entered: false };
    for (let step = 1; step <= DRAG_STEPS; step += 1) {
      const point = {
        x: Math.round(start.x + ((end.x - start.x) * step) / DRAG_STEPS),
        y: Math.round(start.y + ((end.y - start.y) * step) / DRAG_STEPS),
      };
      if (gesture.data) {
        if ((await dragEvent(guest, 'dragOver', point, gesture.data, signal)) === 'dialog') return 'dialog';
        continue;
      }
      if (
        (await mouseEvent(guest, { ...point, type: 'mouseMoved', button: 'left', buttons: 1 }, signal)) === 'dialog'
      ) {
        return 'dialog';
      }
      gesture.data = drags?.take(guest) ?? null;
      if (gesture.data) {
        if ((await dragEvent(guest, 'dragEnter', point, gesture.data, signal)) === 'dialog') return 'dialog';
        gesture.entered = true;
      }
    }
    return gesture;
  }

  async function dragAt(guest: WebContents, source: Point, target: Point, signal?: AbortSignal): Promise<void> {
    const start = cssPoint(source);
    const end = cssPoint(target);
    const drags = options.drags;
    drags?.reset(guest);
    if (drags) await send(guest, 'Input.setInterceptDrags', { enabled: true }, signal);
    try {
      if ((await mouseEvent(guest, { ...start, type: 'mouseMoved', button: 'none' }, signal)) === 'dialog') return;
      if (
        (await mouseEvent(guest, { ...start, type: 'mousePressed', button: 'left', clickCount: 1 }, signal)) ===
        'dialog'
      )
        return;
      const gesture = await dragThrough(guest, start, end, drags, signal);
      if (gesture === 'dialog') return;
      // The payload can still be in flight when the last move returns.
      gesture.data ||= await waitForInterceptedDrag(guest, drags, signal);
      if (!gesture.data) {
        await mouseEvent(guest, { ...end, type: 'mouseReleased', button: 'left', clickCount: 1 }, signal);
        return;
      }
      if (!gesture.entered && (await dragEvent(guest, 'dragEnter', end, gesture.data, signal)) === 'dialog') return;
      if ((await dragEvent(guest, 'dragOver', end, gesture.data, signal)) === 'dialog') return;
      await dragEvent(guest, 'drop', end, gesture.data, signal);
    } finally {
      if (drags) {
        await send(guest, 'Input.setInterceptDrags', { enabled: false }, signal).catch(() => undefined);
      }
    }
  }

  /** Files delivered the way a person drops them: the payload is announced
   *  first, so a zone that only listens for a drag sees it coming. */
  async function dropFilesAt(guest: WebContents, point: Point, paths: string[], signal?: AbortSignal): Promise<void> {
    const data = { items: [], files: [...paths], dragOperationsMask: DRAG_OPERATION_COPY };
    const at = cssPoint(point);
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      if ((await send(guest, 'Input.dispatchDragEvent', { ...at, type, data }, signal)) === 'dialog') return;
    }
  }

  return { dragAt, dropFilesAt };
}
