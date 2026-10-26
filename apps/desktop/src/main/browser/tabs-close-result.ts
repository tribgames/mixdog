/** The session's tab strip after a close, read from the host rather than from
 *  whatever frame a client last saw. The window closes asynchronously (and a
 *  beforeunload veto keeps it open), so wait briefly for the tab to leave.
 *
 *  Closing a session's last tab leaves the host with a blank page of its own;
 *  the host marks that replacement (`isReplacement`), and it alone is not a
 *  tab the user has. Every other tab counts, judged on the final state, so the
 *  panel closes only when no user tab is left. */
import type { DesktopBrowserTab, DesktopBrowserTabControlResult } from '../../shared/contract-browser';

/** The session's tab strip: the one the local pane shows and paired clients drive. */
export interface SessionTabStrip {
  list(sessionId: string): DesktopBrowserTab[];
  select(sessionId: string, tabId: string, follow?: SessionTabFollow): void;
  /** `requestId`: the request (an agent's URL open) that asked for this tab. */
  create(sessionId: string, requestId?: string): void;
  close(sessionId: string, tabId: string): void;
  isReplacement?(sessionId: string, tabId: string): boolean;
}

/** How a `select-tab` is not the user's own pick: `agent` is a pane following
 *  the agent's page, `resume` the user asking to see it again, `view` the
 *  transcript's "보기" showing one page the agent opened. */
export type SessionTabFollow = 'agent' | 'resume' | 'view';

type SessionTabControl =
  | { type: 'new-tab'; requestId?: string }
  | { type: 'select-tab'; tabId: string; follow?: SessionTabFollow }
  | { type: 'close-tab'; tabId: string };

/** Tab chrome targets the session's pages, not the document inside one. */
export function isSessionTabControl<T extends { type: string }>(
  control: T
): control is Extract<T, { type: SessionTabControl['type'] }> {
  return control.type === 'new-tab' || control.type === 'select-tab' || control.type === 'close-tab';
}

/** Run a tab control on the session's strip; a close reports the tabs left. */
export async function controlSessionTab(
  tabs: SessionTabStrip | undefined,
  sessionId: string,
  control: SessionTabControl
): Promise<DesktopBrowserTabControlResult | void> {
  if (!tabs) throw new Error('Browser tabs are unavailable.');
  if (control.type === 'new-tab') tabs.create(sessionId, control.requestId);
  else if (control.type === 'select-tab') tabs.select(sessionId, control.tabId, control.follow);
  else return closeSessionTab(tabs, sessionId, control.tabId);
}

/** How long a close waits for the pane to drop the tab before reporting it
 *  still open, and how often it looks (a cheap in-memory list read). */
const CLOSE_SETTLE_MS = 1_500;
const CLOSE_POLL_MS = 25;

const blankAddress = (tab: DesktopBrowserTab): boolean => tab.url === '' || tab.url === 'about:blank';
const idleBlank = (tab: DesktopBrowserTab): boolean => !tab.loading && blankAddress(tab);

export async function closeSessionTab(
  tabs: {
    list(sessionId: string): DesktopBrowserTab[];
    close(sessionId: string, tabId: string): void;
    /** Whether this tab is the blank page the host made to replace a closed last tab. */
    isReplacement?(sessionId: string, tabId: string): boolean;
  },
  sessionId: string,
  tabId: string
): Promise<{ remainingTabs: number }> {
  const before = tabs.list(sessionId);
  const onlyBlank = before.length === 1 && before[0].id === tabId && idleBlank(before[0]);
  tabs.close(sessionId, tabId);
  let list = tabs.list(sessionId);
  // A blank-only session has nothing to protect from unload; do not wait on it.
  const deadline = Date.now() + (onlyBlank ? 0 : CLOSE_SETTLE_MS);
  while (list.some((tab) => tab.id === tabId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CLOSE_POLL_MS));
    list = tabs.list(sessionId);
  }
  // Judged on the final state: every tab is the user's except the host's own
  // marked replacement (while its address is blank, loading or not: it is
  // still starting up, and the mark is cleared once the user takes it) and a
  // blank sole tab that was asked to close and is going away.
  const userTabs = list.filter(
    (tab) =>
      !(
        (blankAddress(tab) && tabs.isReplacement?.(sessionId, tab.id)) ||
        (onlyBlank && tab.id === tabId && idleBlank(tab))
      )
  );
  return { remainingTabs: userTabs.length };
}
