/** User-facing pages live in non-activating windows, never inside the shell's
 * focus tree. The renderer owns a display client, not the Chromium page. */
import type { BaseWindow, WebContents } from 'electron';
import type { BrowserSessionRegistry } from './session-registry';

export function createBrowserPageOwner(host: {
  sessions: BrowserSessionRegistry;
  create(): { window: BaseWindow; guest: WebContents };
  initialize(guest: WebContents): void;
  /** Work still running against the page; tidying it away waits for it. */
  busy?(sessionId: string, guest: WebContents): boolean;
}) {
  const pages = new Map<string, { window: BaseWindow; guest: WebContents; ready: Promise<void> }>();
  // Sessions whose page went away without a release: the next page the host
  // creates for them replaces a closed one instead of being a user's tab.
  const vacated = new Set<string>();
  const replacements = new Map<string, WebContents>();
  // The initial page the host made on its own (the pane opened first, or an
  // agent command needed one) that no person has taken since.
  const implicitBlanks = new Map<string, WebContents>();

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
      implicitBlanks.set(sessionId, guest);
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
        if (implicitBlanks.get(sessionId) === guest) implicitBlanks.delete(sessionId);
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
    implicitBlanks.delete(sessionId);
    // Electron destroys the page a tick after its window; until then the
    // session would still hand it out (a pane read or command right after a
    // release fails on it), so it leaves the session now.
    if (entry) host.sessions.unregisterVisibleGuest(entry.guest);
    if (entry && !entry.window.isDestroyed()) entry.window.destroy();
  }

  function dispose(): void {
    for (const sessionId of [...pages.keys()]) release(sessionId);
  }

  /** The user took this page (selected it, reused it for a new tab, navigated it):
   *  it no longer stands in for a closed one. */
  function claim(sessionId: string, guest: WebContents): void {
    if (replacements.get(sessionId) === guest) replacements.delete(sessionId);
    if (implicitBlanks.get(sessionId) === guest) implicitBlanks.delete(sessionId);
  }

  /** Closes the session's implicit initial page (made by the pane or by an
   *  agent command, never by "+") once it is still an untouched about:blank
   *  and the agent works in `keep` instead. A page the user took (selected,
   *  "+"-reused, navigated) or one that loaded anything is kept, and so is
   *  the session's last page. */
  function discardUntouchedBlank(sessionId: string, keep: WebContents): boolean {
    const blank = implicitBlanks.get(sessionId);
    const entry = pages.get(sessionId);
    if (!blank || blank === keep || entry?.guest !== blank || entry.window.isDestroyed()) return false;
    if (blank.isDestroyed() || keep.isDestroyed() || host.sessions.sessionIdForGuest(keep) !== sessionId) return false;
    // Still loading, or a command/download/prompt is using it: it stays
    // marked and the next trigger (a later command, the turn's end) retries.
    if (blank.isLoadingMainFrame() || host.busy?.(sessionId, blank)) return false;
    if (blank.getURL() !== 'about:blank' || blank.navigationHistory.length() > 1) {
      implicitBlanks.delete(sessionId);
      return false;
    }
    implicitBlanks.delete(sessionId);
    // Hand the panel to the agent's page first, so closing never leaves it
    // on a fallback that the follower then has to move again.
    if (host.sessions.currentGuest(sessionId) === blank) host.sessions.selectGuest(sessionId, keep);
    entry.window.destroy();
    return true;
  }

  /** The page the host made to stand in for a closed one, if it is still there. */
  function replacement(sessionId: string): WebContents | null {
    return replacements.get(sessionId) ?? null;
  }

  return { ensure, settled, release, dispose, replacement, claim, discardUntouchedBlank };
}
