/** Which page a command runs against: the default visible tab, a page id, a
 *  `v1`-style visible position, or a named background page. */
import type { WebContents } from 'electron';

import { normalizeBackgroundTabName } from './tab-policy';
import type { BackgroundPage, BrowserTabsHost } from './tabs-contract';

export type TabTargetingHost = Pick<
  BrowserTabsHost,
  'visibleGuests' | 'backgroundPages' | 'backgroundEntryByPageId' | 'ensureOffscreen' | 'pageId' | 'selectGuest'
>;

export interface ResolvedTabTarget {
  guest: WebContents;
  background: boolean;
  tabName?: string;
}

const PAGE_ID = /^p\d+$/i;
const VISIBLE_POSITION = /^v(\d+)$/i;

export function createTabTargeting(host: TabTargetingHost) {
  const {
    visibleGuests,
    backgroundPages,
    backgroundEntryByPageId,
    ensureOffscreen,
    pageId: stablePageId,
    selectGuest,
  } = host;

  /** A background page the caller named: a user tab, or a page explicitly
   *  revealed with background:false, is shown; any other stays hidden. */
  function targetBackgroundPage(
    sessionId: string,
    name: string,
    page: BackgroundPage,
    background: boolean | undefined
  ): ResolvedTabTarget {
    const hidden = background !== false && page.kind !== 'user';
    page.lastUsedAt = Date.now();
    if (!hidden) selectGuest(sessionId, page.guest);
    return { guest: page.guest, background: hidden, tabName: name };
  }

  function resolveBackgroundTarget(sessionId: string, tab: string): ResolvedTabTarget {
    if (PAGE_ID.test(tab)) {
      const found = backgroundEntryByPageId(sessionId, tab);
      if (!found) throw new Error(`no background page "${tab}"; call list_tabs`);
      found[1].lastUsedAt = Date.now();
      return { guest: found[1].window.webContents, background: true, tabName: found[0] };
    }
    const name = normalizeBackgroundTabName(tab || 'bg');
    const entry = ensureOffscreen(sessionId, name);
    return { guest: entry.window.webContents, background: true, tabName: name };
  }

  /** Resolve the page a command targets; null means the default visible tab. */
  function resolveTargetGuest(
    sessionId: string,
    background: boolean | undefined,
    tab: string
  ): ResolvedTabTarget | null {
    if (background) return resolveBackgroundTarget(sessionId, tab);
    if (!tab) return null;
    if (PAGE_ID.test(tab)) {
      const picked = visibleGuests(sessionId).find((guest) => stablePageId(guest).toLowerCase() === tab.toLowerCase());
      if (picked) {
        selectGuest(sessionId, picked);
        return { guest: picked, background: false };
      }
      const found = backgroundEntryByPageId(sessionId, tab);
      if (!found) throw new Error(`no page "${tab}"; call list_tabs`);
      return targetBackgroundPage(sessionId, found[0], found[1], background);
    }
    const visibleMatch = VISIBLE_POSITION.exec(tab);
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
    return targetBackgroundPage(sessionId, backgroundName, page, background);
  }

  /** The background page a tab reference names, by page id or by name. */
  function backgroundTabEntry(sessionId: string, tab: string): [string, BackgroundPage] | null {
    if (PAGE_ID.test(tab)) return backgroundEntryByPageId(sessionId, tab);
    const name = normalizeBackgroundTabName(tab, { required: true });
    const page = backgroundPages(sessionId).get(name);
    return page ? [name, page] : null;
  }

  /** Whether a tab reference names one of the session's visible pages, by
   *  page id or by the `v1`-style position list_tabs prints beside it. */
  function visibleTabMatches(sessionId: string, tab: string): boolean {
    const list = visibleGuests(sessionId);
    const position = VISIBLE_POSITION.exec(tab);
    if (position) return Boolean(list[Number(position[1]) - 1]);
    return list.some((guest) => stablePageId(guest).toLowerCase() === tab.toLowerCase());
  }

  return { resolveTargetGuest, backgroundTabEntry, visibleTabMatches };
}
