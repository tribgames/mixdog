import type { WebContents } from 'electron';

import { OFFSCREEN_VIEWPORT } from './host-types';
import { browserPageWindow } from './page-window';
import { setBrowserPageZoom } from './page-zoom';
import { restorablePages } from './restore-pages';
import type { BrowserSessionRegistry } from './session-registry';
import type { BackgroundPage } from './tabs-contract';
import type { BrowserUrlPolicy } from './url-policy';

// Only small navigation descriptors survive runtime eviction, never
// WebContents, screenshots, DOM state, or a second browser idle timer.
type SavedPageBase = {
  url: string;
  active: boolean;
  keepAlive?: boolean;
  /** The tab id, which its restored page takes again. */
  id: string;
  /** A disposable page (the host's untouched initial blank, an agent's unkept
   *  scratch tab): when blank, nothing is brought back. */
  standIn: boolean;
  zoom: number;
  size: [number, number];
};

type SavedPrimaryPage = SavedPageBase & { kind: 'primary' };
type SavedBackgroundPage = SavedPageBase & { kind: BackgroundPage['kind']; name: string };
type SavedPage = SavedPrimaryPage | SavedBackgroundPage;

/** One live page as the descriptor a later restore replays: where it was, how
 *  it was sized and zoomed, and whether it was the selected page. */
function savedPageBase(
  guest: WebContents,
  selected: WebContents | null,
  id: string,
  standIn: boolean,
  keepAlive?: boolean
): SavedPageBase {
  return {
    id,
    standIn,
    keepAlive,
    url: guest.getURL() || 'about:blank',
    active: guest === selected,
    zoom: guest.getZoomFactor(),
    size: (browserPageWindow(guest)?.getContentSize() ?? [OFFSCREEN_VIEWPORT.width, OFFSCREEN_VIEWPORT.height]) as [
      number,
      number,
    ],
  };
}

export function createBrowserSessionRestore(host: {
  sessions: BrowserSessionRegistry;
  urlPolicy: BrowserUrlPolicy;
  /** Runs before suspended pages are recreated (for example, awaiting cookie restoration). */
  beforeRestore?(): Promise<void>;
  /** The session's primary page, created when it has none. */
  ensurePrimaryPage(sessionId: string, pageId?: string): Promise<WebContents>;
  /** The page is the user's from now on, no stand-in. */
  claimPage(sessionId: string, guest: WebContents): void;
  pageId(guest: WebContents): string;
  /** Close one page a restore made, if it is still the session's. */
  discardPage(sessionId: string, guest: WebContents): void;
  /** Whether `guest` is the session's untouched initial blank page. */
  isStandIn(sessionId: string, guest: WebContents): boolean;
  /** Make room for `adding` background pages of the session, or throw why not. */
  admitBackgroundPages(sessionId: string, adding: number): void;
  restoreBackgroundPage(sessionId: string, name: string, kind: BackgroundPage['kind'], pageId: string): BackgroundPage;
  /** Close every page of the session. */
  closeSessionPages(sessionId: string): void;
}) {
  const { sessions, urlPolicy } = host;
  const suspendedSessions = new Map<string, SavedPage[]>();
  const restoringSessions = new Map<string, Promise<void>>();

  /** Unload follows the daemon runtime; deletion also forgets navigation. */
  function releaseSession(sessionId: string, restore = false): void {
    if (restore && !restoringSessions.has(sessionId)) {
      const selected = sessions.currentGuest(sessionId);
      const pages: SavedPage[] = [
        ...sessions.visibleGuests(sessionId).map((guest) => ({
          kind: 'primary' as const,
          ...savedPageBase(guest, selected, host.pageId(guest), host.isStandIn(sessionId, guest)),
        })),
        ...[...sessions.backgroundPages(sessionId)]
          .filter(([, page]) => !page.guest.isDestroyed())
          .map(([name, page]) => ({
            kind: page.kind,
            name,
            ...savedPageBase(
              page.guest,
              selected,
              host.pageId(page.guest),
              // An agent's scratch tab no one kept stands in for nothing once blank.
              page.kind === 'agent' && !page.keepAlive,
              page.keepAlive
            ),
          })),
      ];
      const restorable = restorablePages(pages, urlPolicy).map(({ page }) => page);
      if (restorable.length) suspendedSessions.set(sessionId, restorable);
      else suspendedSessions.delete(sessionId);
    } else if (!restore) {
      suspendedSessions.delete(sessionId);
    }
    restoringSessions.delete(sessionId);
    host.closeSessionPages(sessionId);
  }

  function restoreSession(sessionId: string): Promise<void> {
    const existing = restoringSessions.get(sessionId);
    if (existing) return existing;
    const saved = suspendedSessions.get(sessionId);
    if (!saved) return Promise.resolve();
    const assertStillRestoring = () => {
      if (restoringSessions.get(sessionId) !== work || suspendedSessions.get(sessionId) !== saved) {
        throw new Error('Browser page changed during restore.');
      }
    };
    // Pages this attempt made, so one overtaken by a deletion can take them down.
    const created: WebContents[] = [];
    const work = Promise.resolve()
      .then(async () => {
        // Overtaken before anything exists (deleted, or unloaded again): create nothing.
        assertStillRestoring();
        if (host.beforeRestore) {
          await host.beforeRestore();
          assertStillRestoring();
        }
        // Pages with nothing to come back to (the host's own blank stand-in,
        // an address no longer admitted) are dropped.
        const restorable = restorablePages(saved, urlPolicy);
        const backgrounds = restorable.filter(
          (entry): entry is { page: SavedBackgroundPage; url: string } => entry.page.kind !== 'primary'
        );
        if (backgrounds.length) host.admitBackgroundPages(sessionId, backgrounds.length);
        const primaryEntry = restorable.find(
          (entry): entry is { page: SavedPrimaryPage; url: string } => entry.page.kind === 'primary'
        );
        const primary = primaryEntry ? await host.ensurePrimaryPage(sessionId, primaryEntry.page.id) : null;
        if (primary) created.push(primary);
        assertStillRestoring();
        // Saved without being a stand-in, so it is not one again: the next unload keeps it.
        if (primary) host.claimPage(sessionId, primary);
        let selected: WebContents | null = primary;
        const apply = (guest: WebContents, page: SavedPage, url: string) => {
          browserPageWindow(guest)?.setContentSize(page.size[0], page.size[1]);
          setBrowserPageZoom(guest, page.zoom);
          if (page.active) selected = guest;
          // Restoration is a normal reload, not form/JS/opener resurrection.
          // Admission still runs through the partition and navigation handlers.
          void guest.loadURL(url).catch(() => {});
        };
        if (primary && primaryEntry) apply(primary, primaryEntry.page, primaryEntry.url);
        for (const { page, url } of backgrounds) {
          const entry = host.restoreBackgroundPage(
            sessionId,
            page.name,
            page.kind === 'popup' ? 'user' : page.kind,
            page.id
          );
          created.push(entry.guest);
          // Commit a document before CDP may attach; otherwise its blank-page
          // initialization aborts the URL reload we are trying to restore.
          await entry.guest.loadURL('about:blank');
          assertStillRestoring();
          entry.keepAlive = page.keepAlive || page.kind === 'popup';
          selected ??= entry.guest;
          apply(entry.guest, page, url);
        }
        if (selected) sessions.selectGuest(sessionId, selected);
        suspendedSessions.delete(sessionId);
      })
      .catch((error) => {
        // Preserve descriptors for a retry, but release a partially recreated
        // set. An obsolete restore may never tear down its successor.
        if (restoringSessions.get(sessionId) === work) releaseSession(sessionId, true);
        // Overtaken and no successor restore owns the session: what this attempt
        // made would outlive a deleted session.
        else if (!restoringSessions.has(sessionId)) for (const guest of created) host.discardPage(sessionId, guest);
        throw error;
      });
    restoringSessions.set(sessionId, work);
    void work
      .finally(() => {
        if (restoringSessions.get(sessionId) === work) restoringSessions.delete(sessionId);
      })
      .catch(() => {});
    return work;
  }

  /** Drops any suspended descriptors for an ended session without touching live pages. */
  function forgetSession(sessionId: string): void {
    suspendedSessions.delete(sessionId);
    restoringSessions.delete(sessionId);
  }

  function hasSuspended(sessionId: string): boolean {
    return suspendedSessions.has(sessionId);
  }

  /** Host teardown: nothing is left to restore. */
  function forgetAll(): void {
    suspendedSessions.clear();
    restoringSessions.clear();
  }

  return { releaseSession, restoreSession, forgetSession, hasSuspended, forgetAll };
}
