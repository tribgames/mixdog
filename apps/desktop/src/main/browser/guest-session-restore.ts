/**
 * Session unload and restore. Unloading a session saves what its pages were
 * and closes them; the next use of the session recreates them from those
 * descriptors. Deleting a session forgets them.
 */
import type { WebContents } from 'electron';

import { OFFSCREEN_VIEWPORT } from './command';
import { browserPageWindow } from './page-window';
import { setBrowserPageZoom } from './page-zoom';
import { restorablePages } from './restore-pages';
import type { BrowserSessionRegistry } from './session-registry';
import type { BackgroundPage } from './tabs-contract';
import type { BrowserUrlPolicy } from './url-policy';

// Only small navigation descriptors survive runtime eviction, never
// WebContents, screenshots, DOM state, or a second browser idle timer.
type SavedPage = {
  name?: string;
  kind: 'primary' | BackgroundPage['kind'];
  url: string;
  active: boolean;
  keepAlive?: boolean;
  zoom: number;
  size: [number, number];
};

/** One live page as the descriptor a later restore replays: where it was, how
 *  it was sized and zoomed, and whether it was the selected page. */
function savedPageDescriptor(
  guest: WebContents,
  selected: WebContents | null,
  kind: SavedPage['kind'],
  name?: string,
  keepAlive?: boolean
): SavedPage {
  return {
    name,
    kind,
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
  /** The session's primary page, created when it has none. */
  ensurePrimaryPage(sessionId: string): Promise<WebContents>;
  /** Make room for `adding` background pages of the session, or throw why not. */
  admitBackgroundPages(sessionId: string, adding: number): void;
  restoreBackgroundPage(sessionId: string, name: string, kind: BackgroundPage['kind']): BackgroundPage;
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
      const pages = [
        ...sessions.visibleGuests(sessionId).map((guest) => savedPageDescriptor(guest, selected, 'primary')),
        ...[...sessions.backgroundPages(sessionId)]
          .filter(([, page]) => !page.guest.isDestroyed())
          .map(([name, page]) => savedPageDescriptor(page.guest, selected, page.kind, name, page.keepAlive)),
      ];
      if (pages.length) suspendedSessions.set(sessionId, pages);
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
    const work = Promise.resolve()
      .then(async () => {
        // Pages with nothing to come back to are dropped, never shown blank.
        const restorable = restorablePages(saved, urlPolicy);
        const urls = new Map(restorable.map(({ page, url }) => [page, url]));
        const backgrounds = restorable.map(({ page }) => page).filter((page) => page.kind !== 'primary');
        if (backgrounds.length) host.admitBackgroundPages(sessionId, backgrounds.length);
        const primaryState = restorable.find(({ page }) => page.kind === 'primary')?.page;
        const primary = primaryState ? await host.ensurePrimaryPage(sessionId) : null;
        assertStillRestoring();
        let selected: WebContents | null = primary;
        const apply = (guest: WebContents, page: SavedPage) => {
          browserPageWindow(guest)?.setContentSize(page.size[0], page.size[1]);
          setBrowserPageZoom(guest, page.zoom);
          if (page.active) selected = guest;
          // Restoration is a normal reload, not form/JS/opener resurrection.
          // Admission still runs through the partition and navigation handlers.
          void guest.loadURL(urls.get(page)!).catch(() => {});
        };
        if (primary && primaryState) apply(primary, primaryState);
        for (const page of backgrounds) {
          const entry = host.restoreBackgroundPage(
            sessionId,
            page.name!,
            page.kind === 'popup' ? 'user' : (page.kind as BackgroundPage['kind'])
          );
          // Commit a document before CDP may attach; otherwise its blank-page
          // initialization aborts the URL reload we are trying to restore.
          await entry.guest.loadURL('about:blank');
          assertStillRestoring();
          entry.keepAlive = page.keepAlive || page.kind === 'popup';
          selected ??= entry.guest;
          apply(entry.guest, page);
        }
        if (selected) sessions.selectGuest(sessionId, selected);
        suspendedSessions.delete(sessionId);
      })
      .catch((error) => {
        // Preserve descriptors for a retry, but release a partially recreated
        // set. An obsolete restore may never tear down its successor.
        if (restoringSessions.get(sessionId) === work) releaseSession(sessionId, true);
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

  /** Host teardown: nothing is left to restore. */
  function forgetAll(): void {
    suspendedSessions.clear();
    restoringSessions.clear();
  }

  return { releaseSession, restoreSession, forgetAll };
}
