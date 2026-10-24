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
  /** Whether panes follow the agent's page: a user's own pick or new tab
   *  pauses it for the turn; `resume` ("보기") lifts that. */
  agentFollow?: {
    isPaused(sessionId: string): boolean;
    pause(sessionId: string): void;
    resume(sessionId: string): void;
  };
  currentGuest: BrowserSessionRegistry['currentGuest'];
  lifecycle: {
    claimPage(sessionId: string, guest: WebContents): void;
    replacementPage(sessionId: string): WebContents | null;
  };
  pageId: (guest: WebContents) => string;
  retainGuest: (guest: WebContents) => void;
  /** A new tab's page, once the strip made it the session's current page;
   *  `requestId` names the request that asked for it (none for a user's "+"). */
  onCreate?: (sessionId: string, pageId: string, requestId?: string) => void;
}): SessionTabStrip {
  const { tabs, currentGuest, lifecycle } = options;
  return {
    list: (sessionId) => tabs.displayTabs(sessionId),
    select: (sessionId, tabId, follow) => {
      const { agentFollow } = options;
      if (follow) {
        // A pane following the agent shows its page without claiming it, and
        // never overrides a pick the user made in another window.
        if (follow === 'agent' && agentFollow?.isPaused(sessionId)) return;
        if (follow === 'resume') agentFollow?.resume(sessionId);
        tabs.selectDisplayTab(sessionId, tabId, { retain: false });
        return;
      }
      agentFollow?.pause(sessionId);
      tabs.selectDisplayTab(sessionId, tabId);
      const guest = currentGuest(sessionId);
      if (guest) {
        lifecycle.claimPage(sessionId, guest);
        options.retainGuest(guest);
      }
    },
    create: (sessionId, requestId) => {
      options.agentFollow?.pause(sessionId);
      tabs.createDisplayTab(sessionId);
      // "+" may reuse the blank stand-in page: it is the user's tab from now on.
      const guest = currentGuest(sessionId);
      if (guest) {
        lifecycle.claimPage(sessionId, guest);
        options.onCreate?.(sessionId, options.pageId(guest), requestId);
      }
    },
    close: (sessionId, tabId) => tabs.closeDisplayTab(sessionId, tabId),
    isReplacement: (sessionId, tabId) => {
      const guest = lifecycle.replacementPage(sessionId);
      return guest !== null && !guest.isDestroyed() && options.pageId(guest) === tabId;
    },
  };
}
