/**
 * Which page a command runs against, and what the agent can see of the open
 * ones. A visible tab is addressed by its list position or page id; anything
 * else names a hidden page on the same partition, created on first use so a
 * background task stays logged in without taking the screen.
 */
import type { BrowserWindow, WebContents } from 'electron';

import type { BrowserCommandResult } from './command';
import { redactBrowserText, redactBrowserUrl } from './redaction';
import { normalizeBackgroundTabName } from './tab-policy';

/** A never-shown page the agent drives on the shared partition. */
export interface BackgroundPage {
  window: BrowserWindow;
  guest: WebContents;
  lastUsedAt: number;
  kind: 'agent' | 'popup';
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
}

export function createBrowserTabs(host: BrowserTabsHost) {
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

  return { resolveTargetGuest, listTabs, closeBackgroundTab };
}
