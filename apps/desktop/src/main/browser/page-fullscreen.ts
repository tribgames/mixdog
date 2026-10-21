/**
 * A page's element fullscreen (a video's own button, `requestFullscreen()`) as
 * the person sees it. The page lives in a window the shell never shows, so
 * Chromium's fullscreen alone only grows that hidden window while the pane
 * goes blank. The shell goes fullscreen instead and the pane fills it; the
 * page is then sized to the shown area like any pane resize. Esc, the page's
 * own exit, another tab being shown, or the page closing leaves it, and the
 * shell and pane return to their layout.
 */
import type { BrowserWindow, Event, Input, WebContents } from 'electron';

interface PageFullscreenHost {
  shell: BrowserWindow;
  sessionIdForGuest(guest: WebContents): string | null | undefined;
  currentGuest(sessionId: string): WebContents | null;
  /** The pane of `sessionId` fills the window (or gives it back). */
  changed(sessionId: string, active: boolean): void;
}

export function createPageFullscreen(host: PageFullscreenHost) {
  const { shell } = host;
  /** The pages the shell is fullscreen for, with the session that shows each. */
  const shown = new Map<WebContents, string>();
  let shellWasFullscreen = false;

  const exit = (guest: WebContents): void => {
    if (!guest.isDestroyed()) void guest.executeJavaScript('document.exitFullscreen()').catch(() => {});
  };
  const exitAll = (): void => {
    for (const guest of shown.keys()) exit(guest);
  };
  /** Esc is the person's, not the page's: it leaves fullscreen and goes no further. */
  const onShellInput = (event: Event, input: Input): void => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    event.preventDefault();
    exitAll();
  };

  function enter(guest: WebContents): void {
    const sessionId = host.sessionIdForGuest(guest);
    // A page nobody is looking at has no window to fill.
    if (!sessionId || host.currentGuest(sessionId) !== guest || shell.isDestroyed() || !shell.isVisible()) return;
    if (!shown.size) {
      shellWasFullscreen = shell.isFullScreen();
      shell.webContents.on('before-input-event', onShellInput);
      // Leaving the window's fullscreen by hand leaves the page's too.
      shell.on('leave-full-screen', exitAll);
      if (!shellWasFullscreen) shell.setFullScreen(true);
    }
    shown.set(guest, sessionId);
    host.changed(sessionId, true);
  }

  function leave(guest: WebContents): void {
    const sessionId = shown.get(guest);
    if (sessionId === undefined) return;
    shown.delete(guest);
    host.changed(sessionId, false);
    if (shown.size || shell.isDestroyed()) return;
    shell.webContents.off('before-input-event', onShellInput);
    shell.off('leave-full-screen', exitAll);
    if (!shellWasFullscreen) shell.setFullScreen(false);
  }

  return {
    watch(guest: WebContents): void {
      guest.on('enter-html-full-screen', () => enter(guest));
      guest.on('leave-html-full-screen', () => leave(guest));
      guest.once('destroyed', () => leave(guest));
    },
    /** A tab switch took the session off the fullscreen page: it leaves. */
    reconcile(sessionId: string): void {
      for (const [guest, owner] of shown) {
        if (owner === sessionId && host.currentGuest(sessionId) !== guest) exit(guest);
      }
    },
  };
}
