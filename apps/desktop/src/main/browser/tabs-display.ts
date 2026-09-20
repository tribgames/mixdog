/** The tab strip the desktop pane shows for one session — its visible pages
 *  and live background pages — and the user's actions on it. */
import type { DesktopBrowserTab } from '../../shared/contract';
import type { BackgroundPage, BrowserTabsHost } from './tabs-contract';

export type DisplayTabsHost = Pick<
  BrowserTabsHost,
  'visibleGuests' | 'backgroundPages' | 'ensureOffscreen' | 'pageId' | 'currentGuest' | 'selectGuest' | 'closeGuest'
>;

export function createDisplayTabs(host: DisplayTabsHost) {
  let nextUserTab = 0;
  const { visibleGuests, backgroundPages, ensureOffscreen, pageId: stablePageId, currentGuest, selectGuest } = host;

  function displayEntries(sessionId: string) {
    return [
      ...visibleGuests(sessionId).map((guest) => ({
        guest,
        kind: 'page' as DesktopBrowserTab['kind'],
        page: null as BackgroundPage | null,
      })),
      ...[...backgroundPages(sessionId).values()]
        .filter((page) => !page.window.isDestroyed() && !page.guest.isDestroyed())
        .map((page) => {
          let kind: DesktopBrowserTab['kind'] = 'background';
          if (page.kind === 'popup') kind = 'popup';
          else if (page.kind === 'user') kind = 'page';
          return { guest: page.guest, kind, page };
        }),
    ];
  }

  function displayTabs(sessionId: string): DesktopBrowserTab[] {
    const selected = currentGuest(sessionId);
    return displayEntries(sessionId).map(({ guest, kind }) => ({
      id: stablePageId(guest),
      title: guest.getTitle(),
      url: guest.getURL(),
      loading: guest.isLoadingMainFrame(),
      active: guest === selected,
      kind,
    }));
  }

  function displayEntry(sessionId: string, id: string) {
    const entry = displayEntries(sessionId).find(({ guest }) => stablePageId(guest) === id);
    if (!entry) throw new Error('Browser tab is no longer available in this session.');
    return entry;
  }

  function selectDisplayTab(sessionId: string, id: string): void {
    const { guest, page } = displayEntry(sessionId, id);
    if (page) {
      page.lastUsedAt = Date.now();
      page.keepAlive = true;
    }
    selectGuest(sessionId, guest);
  }

  function createDisplayTab(sessionId: string): void {
    const entries = displayEntries(sessionId);
    const initial = entries.length === 1 && entries[0].page === null ? entries[0].guest : null;
    // Reuse only the initial, idle blank page, not a page navigated back to
    // blank or an independently created user/support tab.
    if (
      initial &&
      initial.getURL() === 'about:blank' &&
      !initial.isLoadingMainFrame() &&
      initial.navigationHistory.length() <= 1
    ) {
      selectGuest(sessionId, initial);
      return;
    }
    let name: string;
    do {
      name = `user-tab-${++nextUserTab}`;
    } while (backgroundPages(sessionId).has(name));
    const page = ensureOffscreen(sessionId, name);
    page.kind = 'user';
    page.keepAlive = true;
    selectGuest(sessionId, page.guest);
  }

  function closeDisplayTab(sessionId: string, id: string): void {
    // Use the window's normal close path so beforeunload can protect edits.
    host.closeGuest(displayEntry(sessionId, id).guest);
  }

  return { displayTabs, selectDisplayTab, createDisplayTab, closeDisplayTab };
}
