/**
 * `open`'s reveal: the page becomes the session's shown tab and its panel is
 * asked to open, then the host waits briefly for a panel to show it. The
 * answer is `shown` or `pending`; a page that closes before or during the
 * wait is a failure, never a pending reveal of nothing.
 */
import type { WebContents } from 'electron';
import type { DesktopBrowserOpenRequest } from '../../shared/contract';

/** What an agent's `open` adds to its reveal request: the page it showed, or
 *  why it failed (the shell routes a child session's line by these). */
export type BrowserOpenDetail = Pick<DesktopBrowserOpenRequest, 'tabId' | 'title' | 'error'>;

/** The display client's request for a session's surface. */
export function browserOpenRequest(
  sessionId: string,
  reveal: boolean | 'hide' | 'handoff',
  detail?: BrowserOpenDetail
): DesktopBrowserOpenRequest {
  if (reveal === 'hide') return { sessionId, hide: true };
  const request: DesktopBrowserOpenRequest =
    reveal === 'handoff' ? { sessionId, reveal: true, handoff: true } : { sessionId, reveal: reveal === true };
  if (detail?.tabId) request.tabId = detail.tabId;
  if (detail?.title) request.title = detail.title;
  if (detail?.error) request.error = detail.error;
  return request;
}

/** What a takeover's surface request names: the handed-over page (its
 *  session-local id and title), so the shell opens exactly that page where
 *  the session's work is on screen; nothing once that page is gone — no tab
 *  is ever guessed in its place. */
export function takeoverRevealDetail(
  guest: WebContents | null,
  pageId: (guest: WebContents) => string
): BrowserOpenDetail | undefined {
  return guest ? { tabId: pageId(guest), title: guest.getTitle() } : undefined;
}

export async function revealBrowserPage(
  host: {
    sessionIdForGuest(guest: WebContents): string | undefined;
    selectGuest(sessionId: string, guest: WebContents): void;
    resumeAgentFollow(sessionId: string): void;
    requestSurface(sessionId: string, detail: BrowserOpenDetail): void;
    pageId(guest: WebContents): string;
    waitUntilShown?(guest: WebContents, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  },
  sessionId: string,
  guest: WebContents,
  settleMs: number,
  signal?: AbortSignal
): Promise<'shown' | 'pending'> {
  const assertOpen = () => {
    if (guest.isDestroyed() || host.sessionIdForGuest(guest) !== sessionId) {
      throw new Error('the page closed before it could be shown');
    }
  };
  assertOpen();
  host.selectGuest(sessionId, guest);
  host.resumeAgentFollow(sessionId);
  host.requestSurface(sessionId, { tabId: host.pageId(guest), title: guest.getTitle() });
  const shown = (await host.waitUntilShown?.(guest, settleMs, signal)) ?? false;
  signal?.throwIfAborted();
  assertOpen();
  return shown ? 'shown' : 'pending';
}
