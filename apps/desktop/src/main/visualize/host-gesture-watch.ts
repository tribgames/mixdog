/**
 * `data-choice` picks need a real gesture in their pane (gestures.ts),
 * observed from the main window's own input, outside page control.
 */
import type { BrowserWindow, WebContents } from 'electron';

import { leasePrefix } from './host-frames';
import {
  type createVisualizeGestureTokens,
  type VisualizeGestureTarget,
  visualizeGestureTarget,
  visualizePaneHitQuery,
} from './gestures';
import type { VisualizeService } from './service';

/** The visualize pane that holds keyboard focus, or null. */
function paneOfFocus(contents: WebContents, snapshot: VisualizeService['snapshot']): VisualizeGestureTarget | null {
  let frame = contents.focusedFrame;
  if (!frame) return null;
  while (frame.parent?.parent) frame = frame.parent;
  // The panel's own document has focus: no pane does.
  if (!frame.parent || frame.isDestroyed()) return null;
  const url = frame.url;
  for (const state of snapshot()) {
    for (const tab of state.tabs) {
      const pane = tab.panes.findIndex(
        (candidate) => candidate.kind === 'html' && url.startsWith(leasePrefix(candidate.url))
      );
      if (pane >= 0) return { sessionId: state.sessionId, tabId: tab.id, pane };
    }
  }
  return null;
}

/** Returns a watcher that mints a gesture token for each real mouse release
 *  or Enter/Space inside a pane; each window's webContents is wired once. */
export function createGestureWatcher(
  gestures: ReturnType<typeof createVisualizeGestureTokens>,
  live: { window(): BrowserWindow | null; snapshot: VisualizeService['snapshot'] }
): (window: BrowserWindow) => void {
  const watched = new WeakSet<WebContents>();
  return (window) => {
    const contents = window.webContents;
    if (watched.has(contents)) return;
    watched.add(contents);
    // A mouse release on a pane's frame itself (screen point → window CSS
    // px); panel UI over the frame is hit instead and mints nothing.
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type !== 'mouseUp' || typeof mouse.globalX !== 'number' || typeof mouse.globalY !== 'number') return;
      const current = live.window();
      if (!current || current.webContents !== contents) return;
      const bounds = current.getContentBounds();
      const zoom = contents.getZoomFactor();
      const point = { x: (mouse.globalX - bounds.x) / zoom, y: (mouse.globalY - bounds.y) / zoom };
      gestures.track(
        contents.executeJavaScript(visualizePaneHitQuery(point)).then((answer: unknown) => {
          const hit = visualizeGestureTarget(answer);
          if (hit) gestures.mint(hit);
        })
      );
    });
    // Enter/Space with keyboard focus inside a pane.
    contents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat || (input.key !== 'Enter' && input.key !== ' ')) return;
      const hit = paneOfFocus(contents, live.snapshot);
      if (hit) gestures.mint(hit);
    });
  };
}
