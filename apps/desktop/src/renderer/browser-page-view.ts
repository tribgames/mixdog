// Showing one exact browser page (tab) of a session in the viewer's panel: the
// transcript's "브라우저 · 보기" and a takeover card's "열기". The desktop
// selects the tab through the pane's own page control; a paired phone has no
// such channel, so a host with conversation tab controls takes the same
// select-tab over the remote browser control. The panel then opens on it.
import { BROWSER_TAB_GONE_MESSAGE } from '../shared/browser-page-control';
import { revealBrowserPane } from './browser-page-request';
import { clearBorrowedBrowserTab, showBorrowedBrowserTab } from './browser-pane-borrowed-tab';

export type BrowserPageViewResult = { status: 'shown' } | { status: 'gone' } | { status: 'failed'; message: string };

/** `viewer`: the conversation whose panel opens; `owner`: the session that
 *  owns the page (another one's shows as a borrowed tab under `ownerName`). */
export async function showBrowserPage(page: {
  viewer: string;
  owner: string;
  ownerName: string;
  tabId: string;
}): Promise<BrowserPageViewResult> {
  const { viewer, owner, ownerName, tabId } = page;
  const api = window.mixdogDesktop;
  try {
    if (api?.browserPageControl) {
      await api.browserPageControl(owner, {
        type: 'select-tab',
        tabId,
        follow: 'view',
        documentId: `${tabId}:0`,
      });
    } else if (api?.remoteBrowserSessionTabs === true && api.remoteBrowserControl) {
      await api.remoteBrowserControl(owner, { type: 'select-tab', tabId });
    }
  } catch (error) {
    // The host's IPC wraps the message, so the missing-tab answer is matched inside it.
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(BROWSER_TAB_GONE_MESSAGE) ? { status: 'gone' } : { status: 'failed', message };
  }
  if (owner !== viewer) showBorrowedBrowserTab(viewer, { ownerSessionId: owner, ownerName, tabId });
  else clearBorrowedBrowserTab(viewer);
  revealBrowserPane(viewer, { showsTab: true });
  return { status: 'shown' };
}
