/**
 * Scripts the desktop host runs inside a displayed tab's HTML panes:
 * annotation overlays and screen reading.
 */
import type { BrowserWindow } from 'electron';

import type { VisualizeTabView } from '../../shared/visualize';
import { visualizeInspectScript } from '../../shared/visualize-inspect';
import { htmlFrames, leasePrefix, paneFrames, retry, shownBody, sleep } from './host-frames';
import { type VisualizeAnnotation, visualizePaneMarks } from '../../shared/visualize-annotations';
import { type VisualizeOverlayResult, visualizeOverlayScript } from './overlay-script';

/** After a pane frame is resized, before the page is read (its layout and
 *  resize handlers settle). */
const RESIZE_SETTLE_MS = 350;

/** Main-window script: size the iframes of the given page-server leases to
 *  `size` (remembering their inline style); returns how many it resized. */
export function resizePaneFramesScript(prefixes: string[], size: { width: number; height: number }): string {
  return `(() => {
    const prefixes = ${JSON.stringify(prefixes)};
    let count = 0;
    for (const frame of document.querySelectorAll('[data-visualize-body] iframe')) {
      if (!prefixes.some((prefix) => frame.src.startsWith(prefix))) continue;
      if (frame.dataset.mixdogInspectStyle === undefined) frame.dataset.mixdogInspectStyle = frame.getAttribute('style') || '';
      for (const [name, value] of [['width', '${size.width}px'], ['min-width', '${size.width}px'], ['max-width', 'none'], ['height', '${size.height}px'], ['min-height', '${size.height}px'], ['max-height', 'none'], ['flex', 'none']]) {
        frame.style.setProperty(name, value, 'important');
      }
      count += 1;
    }
    return count;
  })()`;
}

/** Main-window script: undo `resizePaneFramesScript`. */
export function restorePaneFramesScript(prefixes: string[]): string {
  return `(() => {
    const prefixes = ${JSON.stringify(prefixes)};
    for (const frame of document.querySelectorAll('[data-visualize-body] iframe')) {
      if (!prefixes.some((prefix) => frame.src.startsWith(prefix)) || frame.dataset.mixdogInspectStyle === undefined) continue;
      const style = frame.dataset.mixdogInspectStyle;
      delete frame.dataset.mixdogInspectStyle;
      if (style) frame.setAttribute('style', style);
      else frame.removeAttribute('style');
    }
  })()`;
}

/** The tab's HTML-pane frames once at least one is on screen. */
export function shownHtmlFrames(window: BrowserWindow, tab: VisualizeTabView) {
  return retry(() => {
    const found = htmlFrames(window, tab);
    return found.length ? found : null;
  });
}

/** The window with the tab's body on screen. When it is not, only a remote
 *  device being the sole viewer changes what the error says. */
export async function requireShownWindow(
  sessionId: string,
  tab: VisualizeTabView,
  viewer: {
    requireWindow(): BrowserWindow;
    remoteViewing(sessionId: string): Promise<boolean>;
  },
  remoteOnlyMessage: string
): Promise<BrowserWindow> {
  try {
    const window = viewer.requireWindow();
    await shownBody(window, sessionId, tab);
    return window;
  } catch (error) {
    if (await viewer.remoteViewing(sessionId)) throw new Error(remoteOnlyMessage);
    throw error;
  }
}

/** Shows exactly each HTML pane's marks of `marks` in that pane's frames. */
export async function annotatePanes(window: BrowserWindow, tab: VisualizeTabView, marks: VisualizeAnnotation[]) {
  const frames = await shownHtmlFrames(window, tab);
  return Promise.all(
    frames.map(async ({ pane, index, frame }) => ({
      pane,
      result: (await frame.executeJavaScript(
        visualizeOverlayScript(visualizePaneMarks(marks, index))
      )) as VisualizeOverlayResult,
    }))
  );
}

/** Reads every HTML pane of the tab, laid out at `viewport` for the reading
 *  when given. */
export async function inspectPanes(
  window: BrowserWindow,
  tab: VisualizeTabView,
  { viewport, selector }: { viewport?: { width: number; height: number }; selector?: string }
) {
  const frames = await retry(() => {
    const found = paneFrames(window, tab);
    return found.length ? found : null;
  });
  const script = visualizeInspectScript(selector ? { selector } : {});
  const read = () =>
    Promise.all(
      frames.map(async ({ pane, frame }) => ({ pane, result: (await frame.executeJavaScript(script)) as unknown }))
    );
  if (!viewport) return read();
  // Lay the pane frames out at the requested size for the reading only:
  // the iframe elements live in the panel, so main sizes them there.
  const prefixes = [...new Set(tab.panes.filter((pane) => pane.kind === 'html').map((pane) => leasePrefix(pane.url)))];
  const sized = (await window.webContents.executeJavaScript(resizePaneFramesScript(prefixes, viewport))) as number;
  try {
    if (!sized) {
      throw new Error(
        `the panel could not lay the page out at ${viewport.width}×${viewport.height}; run inspect without a viewport to read it at its current size`
      );
    }
    await sleep(RESIZE_SETTLE_MS);
    return await read();
  } finally {
    await window.webContents
      .executeJavaScript(restorePaneFramesScript(prefixes))
      // Restoring is best effort: the window may be gone, and the reading (or its error) stands.
      .catch(() => {});
  }
}
