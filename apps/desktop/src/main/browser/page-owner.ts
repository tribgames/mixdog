/** User-facing pages live in non-activating windows, never inside the shell's
 * focus tree. The renderer owns a display client, not the Chromium page. */
import type { BaseWindow, WebContents } from 'electron';
import type { BrowserSessionRegistry } from './session-registry';

export function createBrowserPageOwner(host: {
  sessions: BrowserSessionRegistry;
  create(): { window: BaseWindow; guest: WebContents };
  initialize(guest: WebContents): void;
}) {
  const pages = new Map<string, { window: BaseWindow; guest: WebContents; ready: Promise<void> }>();
  // Sessions whose page went away without a release: the next page the host
  // creates for them replaces a closed one instead of being a user's tab.
  const vacated = new Set<string>();
  const replacements = new Map<string, WebContents>();

  async function ensure(sessionId: string): Promise<WebContents> {
    let entry = pages.get(sessionId);
    if (!entry || entry.window.isDestroyed()) {
      const replacing = vacated.delete(sessionId) || entry !== undefined;
      const { window, guest } = host.create();
      if (replacing) replacements.set(sessionId, guest);
      host.sessions.registerVisibleGuest(guest);
      host.sessions.bindVisibleGuest(sessionId, guest.id, true);
      // Commit the initial document before eager debugger attachment. Both
      // owners otherwise try to load about:blank and cancel each other's load.
      entry = { window, guest, ready: guest.loadURL('about:blank').then(() => host.initialize(guest)) };
      pages.set(sessionId, entry);
      const owned = entry;
      entry.ready = entry.ready.catch((error) => {
        if (pages.get(sessionId) === owned) pages.delete(sessionId);
        if (!window.isDestroyed()) window.destroy();
        throw error;
      });
      // Once the page shows an address it is the user's, not a stand-in.
      guest.on('did-navigate', () => {
        if (guest.getURL() !== 'about:blank') claim(sessionId, guest);
      });
      guest.once('destroyed', () => {
        host.sessions.unregisterVisibleGuest(guest);
        if (replacements.get(sessionId) === guest) replacements.delete(sessionId);
        if (pages.get(sessionId) === owned) {
          pages.delete(sessionId);
          vacated.add(sessionId);
        }
      });
    }
    await entry.ready;
    return entry.guest;
  }

  /** A page still committing its initial document; settles once it is usable
   *  (or gone). Callers must not drive a guest before this settles: a load
   *  started earlier aborts the initial one, and the failed page is destroyed. */
  function settled(sessionId: string): Promise<void> {
    const entry = pages.get(sessionId);
    return entry ? entry.ready.catch(() => {}) : Promise.resolve();
  }

  function release(sessionId: string): void {
    const entry = pages.get(sessionId);
    pages.delete(sessionId);
    vacated.delete(sessionId);
    replacements.delete(sessionId);
    if (entry && !entry.window.isDestroyed()) entry.window.destroy();
  }

  function dispose(): void {
    for (const sessionId of [...pages.keys()]) release(sessionId);
  }

  /** The user took this page (selected it, reused it for a new tab, navigated it):
   *  it no longer stands in for a closed one. */
  function claim(sessionId: string, guest: WebContents): void {
    if (replacements.get(sessionId) === guest) replacements.delete(sessionId);
  }

  /** The page the host made to stand in for a closed one, if it is still there. */
  function replacement(sessionId: string): WebContents | null {
    return replacements.get(sessionId) ?? null;
  }

  return { ensure, settled, release, dispose, replacement, claim };
}
