/**
 * What the desktop host reads off the main window: where a visualize tab body
 * is on screen, which frames hold its pages, and a capture of an area.
 */
import type { BrowserWindow, NativeImage, WebFrameMain } from 'electron';

import type { VisualizeTabView } from '../../shared/visualize';

const DISPLAY_RETRIES = 12;
const DISPLAY_RETRY_MS = 150;
const NOT_ON_SCREEN =
  'the visualize tab is not on screen (its side panel is closed or its session is not shown); ask the user to open it, then retry';

/** The main window while it can still be driven: not destroyed, with live contents. */
export function windowAccess(source: () => BrowserWindow | null) {
  const live = (): BrowserWindow | null => {
    const window = source();
    return window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window : null;
  };
  const requireLive = (): BrowserWindow => {
    const window = live();
    if (!window) throw new Error('the Mixdog desktop window is not open');
    return window;
  };
  return { live, require: requireLive };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type BodyRect = { x: number; y: number; width: number; height: number };

/** The displayed tab body's rect right now, or null when it is not on screen. */
export async function bodyRectNow(window: BrowserWindow, sessionId: string, tabId: string): Promise<BodyRect | null> {
  const query = `(() => {
    const nodes = document.querySelectorAll('[data-visualize-body]');
    for (const node of nodes) {
      if (node.dataset.visualizeSession !== ${JSON.stringify(sessionId)}) continue;
      if (node.dataset.visualizeTab !== ${JSON.stringify(tabId)}) continue;
      if (node.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width >= 1 && rect.height >= 1) return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }
    return null;
  })()`;
  return (await window.webContents.executeJavaScript(query)) as BodyRect | null;
}

/** Whether the user can see the displayed tab body: the topmost element at
 *  one of a few points across it (inside the viewport) is the body or within
 *  it. False when a dialog, Settings or another overlay covers it, or a
 *  clipping ancestor hides it; null when the body is not there at all. */
export async function bodyUncoveredNow(
  window: BrowserWindow,
  sessionId: string,
  tabId: string
): Promise<boolean | null> {
  const query = `(() => {
    for (const node of document.querySelectorAll('[data-visualize-body]')) {
      if (node.dataset.visualizeSession !== ${JSON.stringify(sessionId)}) continue;
      if (node.dataset.visualizeTab !== ${JSON.stringify(tabId)}) continue;
      if (node.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const x = rect.left + rect.width * fx;
        const y = rect.top + rect.height * fy;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && node.contains(hit)) return true;
      }
      return false;
    }
    return null;
  })()`;
  return (await window.webContents.executeJavaScript(query)) as boolean | null;
}

/** `http://127.0.0.1:port/<token>/` of a local page URL: every page and asset
 *  of that lease shares it. */
export function leasePrefix(url: string): string {
  const parsed = new URL(url);
  const token = parsed.pathname.split('/')[1] ?? '';
  return `${parsed.origin}/${token}/`;
}

/** Polls `find` until it yields something; throws NOT_ON_SCREEN otherwise. */
export async function retry<T>(find: () => Promise<T | null> | T | null): Promise<T> {
  for (let attempt = 0; attempt < DISPLAY_RETRIES; attempt += 1) {
    const found = await find();
    if (found) return found;
    await sleep(DISPLAY_RETRY_MS);
  }
  throw new Error(NOT_ON_SCREEN);
}

/** The frames showing the tab's HTML panes, with their pane labels and
 *  displayed pane indices. */
export function htmlFrames(
  window: BrowserWindow,
  tab: VisualizeTabView
): Array<{ pane: string; index: number; frame: WebFrameMain }> {
  const frames = window.webContents.mainFrame.framesInSubtree;
  const found: Array<{ pane: string; index: number; frame: WebFrameMain }> = [];
  tab.panes.forEach((pane, index) => {
    if (pane.kind !== 'html') return;
    const prefix = leasePrefix(pane.url);
    for (const frame of frames) {
      if (!frame.isDestroyed() && frame.url.startsWith(prefix)) found.push({ pane: pane.label, index, frame });
    }
  });
  return found;
}

/** The panel's own pane frames: not frames nested inside a page. */
export function paneFrames(
  window: BrowserWindow,
  tab: VisualizeTabView
): Array<{ pane: string; index: number; frame: WebFrameMain }> {
  return htmlFrames(window, tab).filter(({ frame }) => frame.parent !== null && frame.parent.parent === null);
}

/** The tab body's rect once it is really on screen: window shown and not
 *  minimized, panel open, session and tab displayed. Throws otherwise. */
export async function shownBody(window: BrowserWindow, sessionId: string, tab: VisualizeTabView): Promise<BodyRect> {
  if (window.isMinimized() || !window.isVisible()) {
    throw new Error('the Mixdog window is minimized or hidden; restore it, then retry');
  }
  return retry(() => bodyRectNow(window, sessionId, tab.id));
}

/** How far the user can see the displayed tab in this window (see
 *  `VisualizeServiceDeps.onScreen`). */
export async function desktopScreenState(
  window: BrowserWindow,
  sessionId: string,
  tab: VisualizeTabView
): Promise<'visible' | 'background' | 'covered' | 'hidden'> {
  const shown = await shownBody(window, sessionId, tab).then(
    () => true,
    () => false
  );
  if (!shown) return 'hidden';
  const uncovered = await bodyUncoveredNow(window, sessionId, tab.id);
  if (uncovered === null) return 'hidden';
  if (!uncovered) return 'covered';
  return window.isFocused() ? 'visible' : 'background';
}

/** Captures `rect` (CSS px of the window) at the window's zoom. */
export function captureWindowRect(window: BrowserWindow, rect: BodyRect): Promise<NativeImage> {
  const zoom = window.webContents.getZoomFactor();
  return window.webContents.capturePage({
    x: Math.round(rect.x * zoom),
    y: Math.round(rect.y * zoom),
    width: Math.max(1, Math.round(rect.width * zoom)),
    height: Math.max(1, Math.round(rect.height * zoom)),
  });
}

/** PNG bytes of a capture; throws when the capture came back empty. */
export function capturedPng(image: NativeImage): Buffer {
  if (image.isEmpty()) throw new Error('the capture came back empty; make sure the Mixdog window is visible');
  return image.toPNG();
}
