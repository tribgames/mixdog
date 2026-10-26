/**
 * A session's named background pages: the agent's offscreen pages, popups its
 * pages open, and restored ones. Admission and idle reclaim run through the
 * background reclaimer; every page is registered with its session until its
 * window closes.
 */
import type { BaseWindow, WebContents } from 'electron';

import { createBackgroundReclaimer } from './background-reclaim';
import type { GuestAttach } from './guest-initialize';
import { type BrowserGuestStateStore, pushBounded } from './guest-state';
import { pageHasEditedFields } from './login-takeover';
import { type BrowserSessionRegistry, DEFAULT_BROWSER_SESSION_ID } from './session-registry';
import { normalizeBackgroundTabName } from './tab-policy';
import type { BackgroundPage } from './tabs-contract';

interface BrowserBackgroundPagesHost {
  sessions: BrowserSessionRegistry;
  state: BrowserGuestStateStore;
  /** A background page mid-command must not be reclaimed as idle. */
  isBackgroundBusy(sessionId: string, name: string): boolean;
  /** `selected`: a person's gesture opened it, and it is now their selected tab. */
  onPopup?(opener: WebContents, popup: WebContents, selected: boolean): void;
}

/** Background pages are addressed by page id; only a live window can answer. */
function backgroundEntryForPageId(
  sessions: BrowserSessionRegistry,
  state: BrowserGuestStateStore,
  sessionId: string,
  pageId: string
): [string, BackgroundPage] | null {
  for (const entry of sessions.backgroundPages(sessionId)) {
    if (!entry[1].window.isDestroyed() && state.pageId(entry[1].guest).toLowerCase() === pageId.toLowerCase()) {
      return entry;
    }
  }
  return null;
}

/** Destroy one background page's window and forget its registry entry. */
function closeBackgroundPage(
  sessions: BrowserSessionRegistry,
  sessionId: string,
  name: string,
  entry: BackgroundPage
): void {
  if (!entry.window.isDestroyed()) {
    try {
      entry.window.destroy();
    } catch {
      /* teardown already won */
    }
  }
  sessions.deleteBackgroundPage(sessionId, name, entry);
}

function closeAllBackgroundPages(sessions: BrowserSessionRegistry): void {
  for (const [sessionId, name, page] of sessions.allBackgroundEntries()) {
    closeBackgroundPage(sessions, sessionId, name, page);
  }
  sessions.clearBackgroundPages();
}

/** The session's next popup name, never colliding with a page it still holds. */
function nextPopupTabName(sessions: BrowserSessionRegistry, counters: Map<string, number>, sessionId: string): string {
  let nextPopupId = counters.get(sessionId) ?? 0;
  let name = '';
  do {
    name = `popup-${++nextPopupId}`;
  } while (sessions.backgroundPages(sessionId).has(name));
  counters.set(sessionId, nextPopupId);
  return name;
}

/** `create`: a new page and its window. `initialize`: wires a new page as
 *  every guest is wired, its debugger coming up as `attach` says. */
export function createBrowserBackgroundPages(
  host: BrowserBackgroundPagesHost,
  pages: {
    create(): { window: BaseWindow; guest: WebContents };
    initialize(guest: WebContents, attach: GuestAttach): void;
  }
) {
  const { sessions, state } = host;
  const nextPopupIdsBySession = new Map<string, number>();
  const reclaimer = createBackgroundReclaimer({
    sessions,
    isBackgroundBusy: host.isBackgroundBusy,
    holdsUnfinishedWork: (guest) => {
      const record = state.peek(guest);
      return Boolean(
        record &&
          (record.userInput || record.pendingDialog || record.pendingFileChooser || record.sensitiveValues?.size)
      );
    },
    documentGeneration: (guest) => state.peek(guest)?.documentGeneration ?? 0,
    hasEditedFields: pageHasEditedFields,
    close: (sessionId, name, entry) => closeBackgroundPage(sessions, sessionId, name, entry),
  });

  function trackBackgroundPage(
    sessionId: string,
    name: string,
    page: { window: BaseWindow; guest: WebContents },
    kind: BackgroundPage['kind'],
    opener?: WebContents,
    attach: GuestAttach = kind === 'popup' ? 'opened' : 'now'
  ): BackgroundPage {
    const win = page.window;
    const entry: BackgroundPage = {
      window: win,
      guest: page.guest,
      lastUsedAt: Date.now(),
      kind,
      ...(opener ? { openerPageId: state.pageId(opener), opener } : {}),
    };
    sessions.setBackgroundPage(sessionId, name, entry);
    pages.initialize(entry.guest, attach);
    win.once('closed', () => {
      sessions.deleteBackgroundPage(sessionId, name, entry);
    });
    return entry;
  }

  /** Track a popup as its opener session's page, unless capacity is gone.
   *  `select`: a person's gesture opened it in front (popup-focus), so it
   *  becomes the selected tab as their own pick would; an agent's stays
   *  behind and is reported to the agent. */
  function adoptPopup(opener: WebContents, popup: { window: BaseWindow; guest: WebContents }, select: boolean): void {
    if (popup.window.isDestroyed()) return;
    const ownerSessionId = sessions.sessionIdForGuest(opener) ?? DEFAULT_BROWSER_SESSION_ID;
    try {
      reclaimer.admit(ownerSessionId);
    } catch (error) {
      pushBounded(state.for(opener).networkFailures, `Blocked popup creation: ${(error as Error).message}`);
      try {
        popup.window.destroy();
      } catch {
        /* creation already failed */
      }
      return;
    }
    const popupName = nextPopupTabName(sessions, nextPopupIdsBySession, ownerSessionId);
    trackBackgroundPage(ownerSessionId, popupName, popup, 'popup', opener);
    // The opener's next reply has to mention it: a click that opened a tab
    // changes nothing in this document and would otherwise be reported as a
    // click the page ignored.
    pushBounded(state.for(opener).openedPopups, popupName);
    host.onPopup?.(opener, popup.guest, select);
    if (select) {
      sessions.selectGuest(ownerSessionId, popup.guest);
      // Like a tab the person picked: panes stop following the agent's page.
      sessions.pauseAgentFollow(ownerSessionId);
    }
  }

  function ensureOffscreen(sessionId: string, rawName = ''): BackgroundPage {
    const name = normalizeBackgroundTabName(rawName);
    const existing = sessions.backgroundPages(sessionId).get(name);
    if (existing && !existing.window.isDestroyed()) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    reclaimer.admit(sessionId);
    // Never shown: the page runs fully (navigate/click/snapshot are JS, not
    // frames). Screenshots go through CDP Page.captureScreenshot, which renders
    // server-side in the Blink compositor and does not need an on-screen
    // surface — an invalidate() before capture forces the frame.
    return trackBackgroundPage(sessionId, name, pages.create(), 'agent');
  }

  /** Recreate a saved page of an unloaded session; its debugger waits for
   *  the restored page's first document. */
  function restorePage(sessionId: string, name: string, kind: BackgroundPage['kind']): BackgroundPage {
    return trackBackgroundPage(sessionId, name, pages.create(), kind, undefined, 'restored');
  }

  /** Close every background page of one session. */
  function closeSession(sessionId: string): void {
    for (const [name, entry] of [...sessions.backgroundPages(sessionId)]) {
      closeBackgroundPage(sessions, sessionId, name, entry);
    }
  }

  return {
    admit: (sessionId: string, adding?: number) => reclaimer.admit(sessionId, adding),
    sweep: (now?: number) => reclaimer.sweep(now),
    adoptPopup,
    ensureOffscreen,
    restorePage,
    entryByPageId: (sessionId: string, pageId: string) => backgroundEntryForPageId(sessions, state, sessionId, pageId),
    close: (sessionId: string, name: string, entry: BackgroundPage) =>
      closeBackgroundPage(sessions, sessionId, name, entry),
    closeSession,
    closeAll: () => closeAllBackgroundPages(sessions),
    /** A released session numbers its next popups from the start. */
    forgetPopupNames: (sessionId: string) => nextPopupIdsBySession.delete(sessionId),
  };
}
