/**
 * Zoom gestures made inside a visualize pane's own frame (an HTML page, a PDF,
 * a Markdown page) never reach the panel's document: the frame takes the wheel
 * and the keyboard. The main window's webContents still sees them, so they are
 * handed to the renderer, which applies them to the panel under the pointer or
 * focus (visualize-zoom.ts).
 */
import * as electron from 'electron';
import type { Input, WebContents } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract';
import type { DesktopVisualizeEvent, VisualizeZoomInput } from '../../shared/visualize';

/** The zoom a keyboard event asks for: Ctrl/Cmd + = / + / − / _ / 0. */
export function visualizeZoomKey(
  input: Pick<Input, 'type' | 'key' | 'control' | 'meta' | 'alt'>
): VisualizeZoomInput | null {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null;
  if (input.key === '=' || input.key === '+') return 'in';
  if (input.key === '-' || input.key === '_') return 'out';
  if (input.key === '0') return 'reset';
  return null;
}

const watched = new WeakSet<WebContents>();

type Point = { x: number; y: number };

/** A screen point in the page's CSS px: relative to the content origin, then
 *  divided by the page zoom factor (a zoomed page draws `zoom` device px per
 *  CSS px). */
export function pagePoint(cursor: Point, origin: Point, zoom: number): Point {
  const factor = zoom > 0 ? zoom : 1;
  return { x: (cursor.x - origin.x) / factor, y: (cursor.y - origin.y) / factor };
}

/** The mouse pointer in contents' page coordinates. An input-event carries
 *  no position for a wheel, so it is read from the cursor and the window. */
function cursorInPage(contents: WebContents): Point | undefined {
  const window = electron.BrowserWindow.fromWebContents(contents);
  if (!window) return undefined;
  return pagePoint(electron.screen.getCursorScreenPoint(), window.getContentBounds(), contents.getZoomFactor());
}

/** Forwards the zoom gestures of `contents`' subframes once per webContents.
 *  Ctrl+wheel that the page did not take arrives as `zoom-changed` (carrying
 *  no position, so it goes out with where the pointer is, `pointerOf`);
 *  keys count only while a subframe holds focus (the panel's own document
 *  handles the rest itself, so nothing is applied twice). */
export function watchVisualizeZoomInput(
  contents: WebContents,
  pointerOf: (contents: WebContents) => Point | undefined = cursorInPage
): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  const forward = (zoom: VisualizeZoomInput, point?: Point) => {
    if (contents.isDestroyed()) return;
    const event: DesktopVisualizeEvent = { sessionId: '', zoom, ...(point ? { point } : {}) };
    contents.send(DESKTOP_IPC.visualizeChanged, event);
  };
  const sendModifier = (zoomModifier: boolean) => {
    if (!contents.isDestroyed()) contents.send(DESKTOP_IPC.visualizeChanged, { sessionId: '', zoomModifier });
  };
  let held = false;
  contents.on('zoom-changed', (_event, direction) => forward(direction, pointerOf(contents)));
  // The renderer clears its modifier state when the window loses focus.
  contents.on('blur', () => {
    held = false;
  });
  contents.on('before-input-event', (event, input) => {
    // The release of Ctrl/Meta itself may still carry its own flag, so the
    // key's own event decides there.
    const modifier =
      input.key === 'Control' || input.key === 'Meta' ? input.type === 'keyDown' : Boolean(input.control || input.meta);
    const changed = modifier !== held;
    // Tracked in every frame, so a change made while the main frame has focus
    // is not mistaken for the state last reported.
    held = modifier;
    const focused = contents.focusedFrame;
    if (!focused || focused === contents.mainFrame) return;
    // With focus in a frame the panel's document gets no key events: say when
    // Ctrl/Cmd changes, so a document frame can let the wheel through.
    if (changed) sendModifier(modifier);
    const zoom = visualizeZoomKey(input);
    if (!zoom) return;
    // The frame (Chromium's PDF viewer) must not also act on the key.
    event.preventDefault();
    forward(zoom);
  });
}
