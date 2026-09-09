/** User-facing pages live in non-activating windows, never inside the shell's
 * focus tree. The renderer owns a display client, not the Chromium page. */
import { BrowserWindow, type WebContents } from 'electron';
import type { BrowserSessionRegistry } from './session-registry';

export function createBrowserPageOwner(host: {
  sessions: BrowserSessionRegistry;
  windowOptions(): Electron.BrowserWindowConstructorOptions;
  initialize(guest: WebContents): void;
}) {
  const pages = new Map<string, { window: BrowserWindow; ready: Promise<void> }>();

  async function ensure(sessionId: string): Promise<WebContents> {
    let entry = pages.get(sessionId);
    if (!entry || entry.window.isDestroyed()) {
      const window = new BrowserWindow(host.windowOptions());
      const guest = window.webContents;
      host.sessions.registerVisibleGuest(guest);
      host.sessions.bindVisibleGuest(sessionId, guest.id, true);
      // Commit the initial document before eager debugger attachment. Both
      // owners otherwise try to load about:blank and cancel each other's load.
      entry = { window, ready: window.loadURL('about:blank').then(() => host.initialize(guest)) };
      pages.set(sessionId, entry);
      const owned = entry;
      entry.ready = entry.ready.catch(error => {
        if (pages.get(sessionId) === owned) pages.delete(sessionId);
        if (!window.isDestroyed()) window.destroy();
        throw error;
      });
      guest.once('destroyed', () => {
        host.sessions.unregisterVisibleGuest(guest);
        if (pages.get(sessionId) === owned) pages.delete(sessionId);
      });
    }
    await entry.ready;
    return entry.window.webContents;
  }

  function release(sessionId: string): void {
    const entry = pages.get(sessionId);
    pages.delete(sessionId);
    if (entry && !entry.window.isDestroyed()) entry.window.destroy();
  }

  function dispose(): void {
    for (const sessionId of [...pages.keys()]) release(sessionId);
  }

  return { ensure, release, dispose };
}
