import type { BrowserWindow } from 'electron';
import { DESKTOP_IPC } from '../shared/contract-ipc';

/** Shared by ordinary activation and notification clicks; never toggles a
 * visible window closed or leaves a minimized/tray window behind the app. */
export function activateDesktopWindow(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  return true;
}

type RaisableWindow = Pick<
  BrowserWindow,
  | 'isDestroyed'
  | 'isMinimized'
  | 'restore'
  | 'isVisible'
  | 'show'
  | 'focus'
  | 'isFocused'
  | 'setAlwaysOnTop'
  | 'moveTop'
  | 'flashFrame'
  | 'once'
>;

/** activateDesktopWindow for a moment the user is in another app (the
 *  browser after a sign-in). Windows' foreground lock may refuse focus() to a
 *  background process; a brief topmost toggle still raises the window above
 *  the browser, and the taskbar button flashes until the user focuses it. */
export function raiseDesktopWindow(window: RaisableWindow | null, platform = process.platform): boolean {
  if (!activateDesktopWindow(window as BrowserWindow | null) || !window) return false;
  if (platform !== 'win32' || window.isFocused()) return true;
  window.setAlwaysOnTop(true);
  window.moveTop();
  window.setAlwaysOnTop(false);
  window.focus();
  if (!window.isFocused()) {
    window.flashFrame(true);
    window.once('focus', () => {
      if (!window.isDestroyed()) window.flashFrame(false);
    });
  }
  return true;
}

export function openDesktopNotificationSession(window: BrowserWindow | null, sessionId: string): boolean {
  if (!activateDesktopWindow(window) || !window || window.webContents.isDestroyed()) return false;
  window.webContents.send(DESKTOP_IPC.notificationOpenSession, sessionId);
  return true;
}
