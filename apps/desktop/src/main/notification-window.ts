import type { BrowserWindow, Notification } from 'electron';
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

/** Brings this PC's window forward, to a session when the click names one. A
 *  click that finds no window (it is being rebuilt, or was closed for real)
 *  is remembered with its session and carried out by `flush` once the window
 *  exists, instead of leaving only a bare activation behind. */
export function createPrimaryWindowActivation(
  getWindow: () => BrowserWindow | null,
  /** Builds the window again when a click finds none; its caller then `flush`es. */
  recreate?: () => void
) {
  let pending: string | null = null;
  const run = (sessionId: string): boolean => {
    const window = getWindow();
    return sessionId ? openDesktopNotificationSession(window, sessionId) : activateDesktopWindow(window);
  };
  return {
    activate(sessionId = ''): void {
      // A plain activation delivers the session a click left waiting.
      if (run(sessionId || pending || '')) {
        pending = null;
        return;
      }
      // A plain activation never downgrades a remembered session.
      if (sessionId || pending === null) pending = sessionId;
      recreate?.();
    },
    flush(): void {
      if (pending === null) return;
      const sessionId = pending;
      pending = null;
      if (!run(sessionId)) pending = sessionId;
    },
  };
}

/** A native notification only fires 'click' while its object is alive: the
 *  platform toast holds no strong reference to it, so one the caller drops is
 *  garbage collected and a later click does nothing. Keep it until it is
 *  clicked, closed or failed. */
export function retainNotification(live: Set<unknown>, notification: Pick<Notification, 'on'>): void {
  live.add(notification);
  const release = () => {
    live.delete(notification);
  };
  notification.on('click', release);
  notification.on('close', release);
  notification.on('failed', release);
}
