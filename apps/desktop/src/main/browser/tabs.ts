/**
 * Which page a command runs against, and what the agent can see of the open
 * ones. Named support pages stay hidden unless explicitly revealed. Merely
 * targeting an agent page never turns it into a user-owned, persistent tab.
 */
import type { BrowserCommandResult } from './command';
import { redactBrowserText, redactBrowserUrl } from './redaction';
import type { BrowserTabsHost } from './tabs-contract';
import { createDisplayTabs } from './tabs-display';
import { createTabTargeting } from './tabs-target';

export type { BackgroundPage, BrowserTabsHost } from './tabs-contract';

export function createBrowserTabs(host: BrowserTabsHost) {
  const { visibleGuests, backgroundPages, destroyBackgroundPage, pageId: stablePageId, currentGuest } = host;
  const targeting = createTabTargeting(host);

  function listTabs(sessionId: string): BrowserCommandResult {
    const lines: string[] = [];
    visibleGuests(sessionId).forEach((guest, index) => {
      const marker = guest === currentGuest(sessionId) ? ' (active)' : '';
      lines.push(
        `- ${stablePageId(guest)} [v${index + 1}]${marker}: ` +
          `${redactBrowserText(guest.getTitle() || '(untitled)')} — ${redactBrowserUrl(guest.getURL() || 'about:blank')}`
      );
    });
    for (const [name, page] of backgroundPages(sessionId)) {
      if (page.window.isDestroyed()) continue;
      const contents = page.window.webContents;
      const opener = page.openerPageId ? ` from ${page.openerPageId}` : '';
      const kind = page.kind === 'popup' ? `popup${opener}` : 'background';
      lines.push(
        `- ${stablePageId(contents)} ["${name}"] (${kind}): ${redactBrowserText(contents.getTitle() || '(untitled)')} ` +
          `— ${redactBrowserUrl(contents.getURL() || 'about:blank')}`
      );
    }
    if (lines.length === 0) {
      return { text: 'No tabs are open. navigate opens the visible tab; background:true opens a hidden page.' };
    }
    return { text: `Tabs:\n${lines.join('\n')}` };
  }

  function closeBackgroundTab(sessionId: string, tab: string): BrowserCommandResult {
    // list_tabs prints the visible tab with the same page id as any other, so
    // a caller naturally aims close_tab at it. The panel keeps that page for
    // the session, so say what it is instead of sending the caller back to
    // the listing that handed out the id.
    if (targeting.visibleTabMatches(sessionId, tab)) {
      throw new Error(
        `"${tab}" is the visible tab, which stays with the browser panel; navigate it elsewhere, or call hide to put the panel away.`
      );
    }
    const found = targeting.backgroundTabEntry(sessionId, tab);
    if (!found || found[1].window.isDestroyed()) {
      throw new Error(`unknown background tab "${tab}"; call list_tabs`);
    }
    const [name, page] = found;
    destroyBackgroundPage(sessionId, name, page);
    return { text: `Closed background tab "${name}".` };
  }

  return {
    resolveTargetGuest: targeting.resolveTargetGuest,
    listTabs,
    closeBackgroundTab,
    ...createDisplayTabs(host),
  };
}
