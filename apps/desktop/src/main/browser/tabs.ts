/**
 * Which page a command runs against, and what the agent can see of the open
 * ones. A visible tab is addressed by its list position or page id; anything
 * else names a hidden page on the same partition, created on first use so a
 * background task stays logged in without taking the screen.
 */
import type { BrowserWindow, WebContents } from 'electron';

import type { DesktopBrowserTab } from '../../shared/contract';
import type { BrowserCommandResult } from './command';
import { redactBrowserText, redactBrowserUrl } from './redaction';
import { normalizeBackgroundTabName } from './tab-policy';

/** A never-shown page the agent drives on the shared partition. */
export interface BackgroundPage {
  window: BrowserWindow;
  guest: WebContents;
  lastUsedAt: number;
  kind: 'agent' | 'popup' | 'user';
  keepAlive?: boolean;
  openerPageId?: string;
}

export interface BrowserTabsHost {
  /** Visible pane guests owned by one session, in stable attach order. */
  visibleGuests(sessionId: string): WebContents[];
  backgroundPages(sessionId: string): Map<string, BackgroundPage>;
  backgroundEntryByPageId(
    sessionId: string,
    pageId: string,
  ): [string, BackgroundPage] | null;
  ensureOffscreen(sessionId: string, rawName?: string): BackgroundPage;
  destroyBackgroundPage(
    sessionId: string,
    name: string,
    entry: BackgroundPage,
  ): void;
  pageId(guest: WebContents): string;
  currentGuest(sessionId: string): WebContents | null;
  /** Targeting a visible tab also makes it the default for later commands. */
  selectGuest(sessionId: string, guest: WebContents): void;
  closeGuest(guest: WebContents): void;
}

export function createBrowserTabs(host: BrowserTabsHost) {
  let nextUserTab = 0;
  const {
    visibleGuests,
    backgroundPages,
    backgroundEntryByPageId,
    ensureOffscreen,
    destroyBackgroundPage,
    pageId: stablePageId,
    currentGuest,
    selectGuest,
  } = host;
  /** Resolve the page a command targets; null means the default visible tab. */
  function resolveTargetGuest(
    sessionId: string,
    background: boolean,
    tab: string,
  ): { guest: WebContents; background: boolean; tabName?: string } | null {
    if (background) {
      if (/^p\d+$/i.test(tab)) {
        const found = backgroundEntryByPageId(sessionId, tab);
        if (!found) throw new Error(`no background page "${tab}"; call list_tabs`);
        found[1].lastUsedAt = Date.now();
        return { guest: found[1].window.webContents, background: true, tabName: found[0] };
      }
      const name = normalizeBackgroundTabName(tab || 'bg');
      const entry = ensureOffscreen(sessionId, name);
      return { guest: entry.window.webContents, background: true, tabName: name };
    }
    if (!tab) return null;
    if (/^p\d+$/i.test(tab)) {
      const picked = visibleGuests(sessionId)
        .find((guest) => stablePageId(guest).toLowerCase() === tab.toLowerCase());
      if (picked) {
        selectGuest(sessionId, picked);
        return { guest: picked, background: false };
      }
      const found = backgroundEntryByPageId(sessionId, tab);
      if (!found) throw new Error(`no page "${tab}"; call list_tabs`);
      found[1].lastUsedAt = Date.now();
      return { guest: found[1].window.webContents, background: true, tabName: found[0] };
    }
    const visibleMatch = /^v(\d+)$/i.exec(tab);
    if (visibleMatch) {
      const list = visibleGuests(sessionId);
      const picked = list[Number(visibleMatch[1]) - 1];
      if (!picked) throw new Error(`no visible tab "${tab}" (${list.length} open); call list_tabs`);
      selectGuest(sessionId, picked);
      return { guest: picked, background: false };
    }
    const backgroundName = normalizeBackgroundTabName(tab, { required: true });
    const page = backgroundPages(sessionId).get(backgroundName);
    if (!page || page.window.isDestroyed()) {
      throw new Error(`unknown tab "${backgroundName}"; call list_tabs, or pass background:true to create it`);
    }
    page.lastUsedAt = Date.now();
    return { guest: page.window.webContents, background: true, tabName: backgroundName };
  }

  function listTabs(sessionId: string): BrowserCommandResult {
    const lines: string[] = [];
    visibleGuests(sessionId).forEach((guest, index) => {
      const marker = guest === currentGuest(sessionId) ? ' (active)' : '';
      lines.push(
        `- ${stablePageId(guest)} [v${index + 1}]${marker}: `
        + `${redactBrowserText(guest.getTitle() || '(untitled)')} — ${redactBrowserUrl(guest.getURL() || 'about:blank')}`,
      );
    });
    for (const [name, page] of backgroundPages(sessionId)) {
      if (page.window.isDestroyed()) continue;
      const contents = page.window.webContents;
      const kind = page.kind === 'popup'
        ? `popup${page.openerPageId ? ` from ${page.openerPageId}` : ''}`
        : 'background';
      lines.push(
        `- ${stablePageId(contents)} ["${name}"] (${kind}): ${redactBrowserText(contents.getTitle() || '(untitled)')} `
        + `— ${redactBrowserUrl(contents.getURL() || 'about:blank')}`,
      );
    }
    if (lines.length === 0) {
      return { text: 'No tabs are open. navigate opens the visible tab; background:true opens a hidden page.' };
    }
    return { text: `Tabs:\n${lines.join('\n')}` };
  }

  function closeBackgroundTab(sessionId: string, tab: string): BrowserCommandResult {
    const found = /^p\d+$/i.test(tab)
      ? backgroundEntryByPageId(sessionId, tab)
      : (() => {
        const name = normalizeBackgroundTabName(tab, { required: true });
        const page = backgroundPages(sessionId).get(name);
        return page ? [name, page] as [string, BackgroundPage] : null;
      })();
    if (!found || found[1].window.isDestroyed()) {
      throw new Error(`unknown background tab "${tab}"; call list_tabs`);
    }
    const [name, page] = found;
    destroyBackgroundPage(sessionId, name, page);
    return { text: `Closed background tab "${name}".` };
  }

  function displayEntries(sessionId: string) {
    return [
      ...visibleGuests(sessionId).map(guest => ({
        guest, kind: 'page' as DesktopBrowserTab['kind'], page: null as BackgroundPage | null,
      })),
      ...[...backgroundPages(sessionId).values()]
        .filter(page => !page.window.isDestroyed() && !page.guest.isDestroyed())
        .map(page => ({
          guest: page.guest,
          kind: (page.kind === 'popup' ? 'popup' : page.kind === 'user' ? 'page' : 'background') as DesktopBrowserTab['kind'],
          page,
        })),
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
    let name: string;
    do { name = `user-tab-${++nextUserTab}`; } while (backgroundPages(sessionId).has(name));
    const page = ensureOffscreen(sessionId, name);
    page.kind = 'user';
    page.keepAlive = true;
    selectGuest(sessionId, page.guest);
  }

  function closeDisplayTab(sessionId: string, id: string): void {
    // Use the window's normal close path so beforeunload can protect edits.
    host.closeGuest(displayEntry(sessionId, id).guest);
  }

  return {
    resolveTargetGuest, listTabs, closeBackgroundTab,
    displayTabs, selectDisplayTab, createDisplayTab, closeDisplayTab,
  };
}
