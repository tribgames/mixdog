/** User-facing pages live in non-activating windows, never inside the shell's
 * focus tree. The renderer owns a display client, not the Chromium page. */
import type { BaseWindow, WebContents } from 'electron';
import type { BrowserSessionRegistry } from './session-registry';

export function createBrowserPageOwner(host: {
  sessions: BrowserSessionRegistry;
  /** Runs before a new page window is created (for example, awaiting cookie restoration). */
  beforeCreate?(): Promise<void>;
  create(): { window: BaseWindow; guest: WebContents };
  initialize(guest: WebContents): void;
  adoptPage(guest: WebContents, pageId: string): void;
  /** Work still running against the page; tidying it away waits for it. */
  busy?(sessionId: string, guest: WebContents): boolean;
}) {
  const pages = new Map<string, { window: BaseWindow; guest: WebContents; ready: Promise<void> }>();
  const pendingCreates = new Map<string, Promise<WebContents>>();
  // Sessions whose page went away without a release: the next page the host
  // creates for them replaces a closed one instead of being a user's tab.
  const vacated = new Set<string>();
  const replacements = new Map<string, WebContents>();
  // The initial page the host made on its own (the pane opened first, or an
  // agent command needed one) that no person has taken since.
  const implicitBlanks = new Map<string, WebContents>();

  async function createAndReady(sessionId: string, pageId?: string): Promise<WebContents> {
    let entry = pages.get(sessionId);
    if (!entry || entry.window.isDestroyed()) {
      const replacing = vacated.delete(sessionId) || entry !== undefined;
      const { window, guest } = host.create();
      if (pageId) host.adoptPage(guest, pageId);
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

  /** `pageId`: the tab id the page takes, when it recreates an unloaded one. */
  async function ensure(sessionId: string, pageId?: string): Promise<WebContents> {
    const existing = pages.get(sessionId);
    if (existing && !existing.window.isDestroyed()) {
      await existing.ready;
      return existing.guest;
    }
    if (host.beforeCreate) {
      const inflight = pendingCreates.get(sessionId);
      if (inflight) return await inflight;
      const beforeCreate = host.beforeCreate;
      const work: Promise<WebContents> = beforeCreate().then(async () => {
        if (pendingCreates.get(sessionId) !== work) {
          throw new Error('Browser page creation cancelled.');
        }
        return await createAndReady(sessionId, pageId);
      });
      pendingCreates.set(sessionId, work);
      try {
        return await work;
      } finally {
        if (pendingCreates.get(sessionId) === work) pendingCreates.delete(sessionId);
      }
    }
    return await createAndReady(sessionId, pageId);
  }

  /** A page still committing its initial document; settles once it is usable
   *  (or gone). Callers must not drive a guest before this settles: a load
   *  started earlier aborts the initial one, and the failed page is destroyed. */
  function settled(sessionId: string): Promise<void> {
    const entry = pages.get(sessionId);
    if (entry) return entry.ready.catch(() => {});
    const pending = pendingCreates.get(sessionId);
    return pending
      ? pending.then(
          () => {},
          () => {}
        )
      : Promise.resolve();
  }

  function release(sessionId: string): void {
    pendingCreates.delete(sessionId);
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
    pendingCreates.clear();
    for (const sessionId of [...pages.keys()]) release(sessionId);
  }

  /** The user took this page (selected it, reused it for a new tab, navigated it):
   *  it no longer stands in for a closed one. */
  function claim(sessionId: string, guest: WebContents): void {
    if (replacements.get(sessionId) === guest) replacements.delete(sessionId);
    if (implicitBlanks.get(sessionId) === guest) implicitBlanks.delete(sessionId);
  }

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

  /** Whether `guest` is the initial blank page the host made on its own and no
   *  person has taken: nothing of the user's is lost when it is not restored. */
  function isStandIn(sessionId: string, guest: WebContents): boolean {
    return implicitBlanks.get(sessionId) === guest;
  }

  /** The page the host made to stand in for a closed one, if it is still there. */
  function replacement(sessionId: string): WebContents | null {
    return replacements.get(sessionId) ?? null;
  }

  return { ensure, settled, release, dispose, replacement, claim, discardUntouchedBlank, isStandIn };
}
