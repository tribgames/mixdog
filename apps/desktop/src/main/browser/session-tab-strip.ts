/**
 * One session tab strip for the local pane and for paired clients' tab controls.
 */
import type { WebContents } from 'electron';
import type { BrowserSessionRegistry } from './session-registry';
import type { SessionTabStrip } from './tabs-close-result';
import type { createBrowserTabs } from './tabs';

export function createBrowserSessionTabStrip(options: {
  tabs: Pick<
    ReturnType<typeof createBrowserTabs>,
    'displayTabs' | 'selectDisplayTab' | 'createDisplayTab' | 'closeDisplayTab'
  >;
  currentGuest: BrowserSessionRegistry['currentGuest'];
  lifecycle: {
    claimPage(sessionId: string, guest: WebContents): void;
    replacementPage(sessionId: string): WebContents | null;
  };
  pageId: (guest: WebContents) => string;
  retainGuest: (guest: WebContents) => void;
}): SessionTabStrip {
  const { tabs, currentGuest, lifecycle } = options;
  return {
    list: (sessionId) => tabs.displayTabs(sessionId),
    select: (sessionId, tabId) => {
      tabs.selectDisplayTab(sessionId, tabId);
      const guest = currentGuest(sessionId);
      if (guest) {
        lifecycle.claimPage(sessionId, guest);
        options.retainGuest(guest);
      }
    },
    create: (sessionId) => {
      tabs.createDisplayTab(sessionId);
      // "+" may reuse the blank stand-in page: it is the user's tab from now on.
      const guest = currentGuest(sessionId);
      if (guest) lifecycle.claimPage(sessionId, guest);
    },
    close: (sessionId, tabId) => tabs.closeDisplayTab(sessionId, tabId),
    isReplacement: (sessionId, tabId) => {
      const guest = lifecycle.replacementPage(sessionId);
      return guest !== null && !guest.isDestroyed() && options.pageId(guest) === tabId;
    },
  };
}
