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
/** A press point that can start a native drag earns the wait its renderer
 *  needs: the payload only exists once the page's own dragstart has run,
 *  which a busy page reaches several frames after the last move. */
const DRAG_NATIVE_PAYLOAD_MS = 2_000;
/** Nothing there starts a drag, so the gesture belongs to the mouse path. A
 *  surprise dragstart still gets a moment, never long enough to stall an
 *  ordinary mouse drag. */
const DRAG_UNEXPECTED_PAYLOAD_MS = 120;
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
 *  itself; it only asks what this one gesture produced. */
export interface BrowserDragInterception {
  /** Open one gesture, discarding anything an earlier gesture left behind. */
  begin(guest: WebContents): void;
  /** The payload of the gesture in flight, once Chromium has delivered it. */
  take(guest: WebContents): BrowserDragData | null;
  /** Resolve the moment Chromium delivers this gesture's payload, or with
   *  null once the wait is spent. */
  waitFor(guest: WebContents, timeoutMs: number, signal?: AbortSignal): Promise<BrowserDragData | null>;
  /** Whether anything at the press point can start a native HTML5 drag. */
  startsNativeDrag(guest: WebContents, point: Point, signal?: AbortSignal): Promise<boolean>;
  /** Close the gesture, handing back a payload that arrived too late to use. */
  end(guest: WebContents): BrowserDragData | null;
}

/** Where a delivered payload lands, and who to wake when it does. */
export interface BrowserDragSlots {
  interceptedDrag?: BrowserDragData;
  notifyInterceptedDrag?: (data: BrowserDragData) => void;
}

/** What the host lends the interception: the per-page slots Chromium's
 *  payload lands in, and a way to ask the page about its own drag sources. */
export interface BrowserDragInterceptionDeps {
  slots: {
    for(guest: WebContents): BrowserDragSlots;
    peek(guest: WebContents): BrowserDragSlots | undefined;
  };
  evaluate(guest: WebContents, expression: string, signal?: AbortSignal): Promise<unknown>;
}

/** Where one gesture stands: the payload Chromium intercepted, if any, and
 *  whether the page has already been told the drag entered it. */
interface DragGesture {
  data: BrowserDragData | null;
  entered: boolean;
}

/** Walk the press point's element chain — through frames, shadow roots and
 *  ancestors — for something Chromium drags by itself. A frame that cannot be
 *  read answers "maybe", which keeps the longer wait rather than abandoning a
 *  drag the page would have completed. */
function nativeDragSourceExpression(point: Point): string {
  return `(() => {
    let doc = document;
    let x = ${point.x};
    let y = ${point.y};
    for (let depth = 0; depth < 8; depth += 1) {
      let element = doc.elementFromPoint(x, y);
      if (!element) return false;
      while (element.shadowRoot) {
        const inner = element.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === element) break;
        element = inner;
      }
      const tag = String(element.tagName || '').toLowerCase();
      if (tag === 'iframe' || tag === 'frame') {
        let inner = null;
        try {
          inner = element.contentDocument;
        } catch {
          return true;
        }
        if (!inner) return true;
        const rect = element.getBoundingClientRect();
        doc = inner;
        x -= rect.left;
        y -= rect.top;
        continue;
      }
      for (let node = element; node; ) {
        if (node.draggable === true) return true;
        const name = String(node.tagName || '').toLowerCase();
        if (name === 'img') return true;
        if (name === 'a' && node.getAttribute && node.getAttribute('href')) return true;
        const root = node.parentElement ? null : node.getRootNode && node.getRootNode();
        node = node.parentElement || (root && root.host) || null;
      }
      return false;
    }
    return false;
  })()`;
}

/** One payload per gesture, delivered by the event that carries it rather
 *  than polled for, and never inherited by the gesture that follows. */
export function createBrowserDragInterception(deps: BrowserDragInterceptionDeps): BrowserDragInterception {
  function clear(guest: WebContents): BrowserDragData | null {
    const slots = deps.slots.peek(guest);
    if (!slots) return null;
    const pending = slots.interceptedDrag ?? null;
    slots.interceptedDrag = undefined;
    slots.notifyInterceptedDrag = undefined;
    return pending;
  }
  return {
    begin(guest) {
      const slots = deps.slots.for(guest);
      slots.interceptedDrag = undefined;
      slots.notifyInterceptedDrag = undefined;
    },
    take(guest) {
      const slots = deps.slots.peek(guest);
      const pending = slots?.interceptedDrag ?? null;
      if (slots && pending) slots.interceptedDrag = undefined;
      return pending;
    },
    end: (guest) => clear(guest),
    waitFor(guest, timeoutMs, signal) {
      return new Promise<BrowserDragData | null>((resolve, reject) => {
        const slots = deps.slots.for(guest);
        const delivered = slots.interceptedDrag;
        if (delivered) {
          slots.interceptedDrag = undefined;
          resolve(delivered);
          return;
        }
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('drag cancelled'));
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (finish: () => void) => {
          if (timer) clearTimeout(timer);
          slots.notifyInterceptedDrag = undefined;
          signal?.removeEventListener('abort', onAbort);
          finish();
        };
        const onAbort = () => settle(() => reject(signal?.reason ?? new Error('drag cancelled')));
        timer = setTimeout(() => settle(() => resolve(null)), timeoutMs);
        slots.notifyInterceptedDrag = (data) => {
          slots.interceptedDrag = undefined;
          settle(() => resolve(data));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    startsNativeDrag(guest, point, signal) {
      return deps
        .evaluate(guest, nativeDragSourceExpression(point), signal)
        .then((answer) => answer !== false)
        .catch(() => true);
    },
  };
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
    drags?.begin(guest);
    if (drags) await send(guest, 'Input.setInterceptDrags', { enabled: true }, signal);
    try {
      // Asking the page first keeps the two outcomes apart: a card that drags
      // itself deserves the wait its renderer needs, while a canvas that only
      // tracks the mouse must not be held open for a payload that never comes.
      const native = drags ? await drags.startsNativeDrag(guest, start, signal) : false;
      if ((await mouseEvent(guest, { ...start, type: 'mouseMoved', button: 'none' }, signal)) === 'dialog') return;
      if (
        (await mouseEvent(guest, { ...start, type: 'mousePressed', button: 'left', clickCount: 1 }, signal)) ===
        'dialog'
      )
        return;
      const gesture = await dragThrough(guest, start, end, drags, signal);
      if (gesture === 'dialog') return;
      // The payload can still be in flight when the last move returns.
      if (!gesture.data && drags) {
        const payloadMs = native ? DRAG_NATIVE_PAYLOAD_MS : DRAG_UNEXPECTED_PAYLOAD_MS;
        gesture.data = await drags.waitFor(guest, payloadMs, signal);
      }
      if (!gesture.data) {
        await mouseEvent(guest, { ...end, type: 'mouseReleased', button: 'left', clickCount: 1 }, signal);
        return;
      }
      if (!gesture.entered && (await dragEvent(guest, 'dragEnter', end, gesture.data, signal)) === 'dialog') return;
      if ((await dragEvent(guest, 'dragOver', end, gesture.data, signal)) === 'dialog') return;
      await dragEvent(guest, 'drop', end, gesture.data, signal);
    } finally {
      // A payload that lands after the gesture gave up belongs to a drag the
      // page still believes is running — and to no later gesture.
      const stray = drags?.end(guest) ?? null;
      if (stray) {
        await send(guest, 'Input.dispatchDragEvent', { ...end, type: 'dragCancel', data: stray }, signal).catch(
          () => undefined
        );
      }
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
