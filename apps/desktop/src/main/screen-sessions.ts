// Which sessions a window actually shows. A completion is only worth hiding
// when the user is looking at that very session; a focused window showing
// another chat (or a bot's relay chat) must not swallow it.

import { DESKTOP_IPC } from '../shared/contract-ipc';

export interface ScreenWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
}

/** Session ids each renderer last reported as painted (one active tab per pane). */
const reported = new WeakMap<object, ReadonlySet<string>>();

/** Store a window's painted sessions; anything but an array of ids is ignored
 *  down to the valid ids, never widened. */
export function reportScreenSessions(window: object, value: unknown): void {
  const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  reported.set(window, new Set(ids));
}

/** Forget what a window reported: its page is gone, so nothing is painted. */
export function clearScreenSessions(window: object): void {
  reported.delete(window);
}

interface ScreenWindowContents {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

interface ScreenWindowIpc {
  on(channel: string, listener: (event: { sender: unknown }, sessionIds: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: { sender: unknown }, sessionIds: unknown) => void): unknown;
}

/** Wires one window's report channel. A report describes the page that sent
 *  it, so it is dropped when that page is replaced (reload, navigation) or
 *  its renderer dies; the next page reports afresh. Returns the teardown. */
export function registerScreenSessions(
  window: object & { webContents: ScreenWindowContents },
  ipcMain: ScreenWindowIpc
): () => void {
  const { webContents } = window;
  const onReport = (event: { sender: unknown }, sessionIds: unknown): void => {
    if (event.sender === webContents) reportScreenSessions(window, sessionIds);
  };
  const onNavigation = (details: { isMainFrame?: boolean; isSameDocument?: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) clearScreenSessions(window);
  };
  const onGone = (): void => clearScreenSessions(window);
  ipcMain.on(DESKTOP_IPC.reportScreenSessions, onReport);
  webContents.on('did-start-navigation', onNavigation);
  webContents.on('render-process-gone', onGone);
  return () => {
    ipcMain.removeListener(DESKTOP_IPC.reportScreenSessions, onReport);
    webContents.removeListener('did-start-navigation', onNavigation);
    webContents.removeListener('render-process-gone', onGone);
    clearScreenSessions(window);
  };
}

/** True only while the window is up, in front and painting `sessionId`. */
export function isSessionOnScreen(window: ScreenWindow | null | undefined, sessionId: string): boolean {
  if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized() || !window.isFocused()) {
    return false;
  }
  return reported.get(window)?.has(sessionId) === true;
}
