/**
 * Requests to the display client for a session's surface: reveal, hide, or
 * hand off its panel, an agent `open`'s reveal, and a failed open's line.
 * They never touch page ownership or OS focus.
 */
import type { BrowserWindow, WebContents } from 'electron';

import { DESKTOP_IPC, type DesktopBrowserOpenRequest } from '../../shared/contract';
import type { BrowserGuestStateStore } from './guest-state';
import { type BrowserOpenDetail, browserOpenRequest, revealBrowserPage } from './page-reveal';
import type { BrowserSessionRegistry } from './session-registry';

/** How long an `open` waits for a panel to show its page before it reports
 *  the reveal as pending: a first open loads the pane and attaches the page. */
const REVEAL_SETTLE_MS = 3_000;

interface BrowserSurfaceRequestsHost {
  window: BrowserWindow;
  sessions: BrowserSessionRegistry;
  state: BrowserGuestStateStore;
  /** The display client was asked to reveal or hide the session's surface. */
  onSurfaceRequest?(request: DesktopBrowserOpenRequest): void;
  /** True once a panel (or native view) on this PC shows the page; false
   *  when none does within `timeoutMs` (display-tracking). */
  waitUntilShown?(guest: WebContents, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
}

export function createBrowserSurfaceRequests(host: BrowserSurfaceRequestsHost) {
  const { window, sessions, state } = host;

  /** `handoff`: a takeover needs the user on the page, so the panel opens even
   *  where they closed it. `detail`: what an agent's `open` showed, or why it
   *  failed (browserOpenRequest). */
  function requestBrowserSurface(
    sessionId: string,
    reveal: boolean | 'hide' | 'handoff',
    detail?: BrowserOpenDetail
  ): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error('desktop window is unavailable');
    }
    const request: DesktopBrowserOpenRequest = browserOpenRequest(sessionId, reveal, detail);
    window.webContents.send(DESKTOP_IPC.browserOpenRequested, request);
    // An explicit reveal or hide is an agent handoff paired clients must see too.
    host.onSurfaceRequest?.(request);
  }

  /** `open`: `shown` once a panel on screen displays the page; `pending` when
   *  the session is not on screen (the shell holds the reveal until it is,
   *  see use-agent-browser-surface-requests) or the user keeps its panel
   *  closed. Throws when no panel can be asked or the page closes meanwhile. */
  function revealPage(sessionId: string, guest: WebContents, signal?: AbortSignal): Promise<'shown' | 'pending'> {
    return revealBrowserPage(
      {
        sessionIdForGuest: (page) => sessions.sessionIdForGuest(page),
        selectGuest: (id, page) => sessions.selectGuest(id, page),
        resumeAgentFollow: (id) => sessions.resumeAgentFollow(id),
        requestSurface: (id, detail) => requestBrowserSurface(id, true, detail),
        pageId: (page) => state.pageId(page),
        waitUntilShown: host.waitUntilShown,
      },
      sessionId,
      guest,
      REVEAL_SETTLE_MS,
      signal
    );
  }

  /** A failed `open` tells the shell why (its owner conversation's line);
   *  nothing is revealed for it. With no window to tell, there is no line. */
  function reportOpenFailure(sessionId: string, error: string, tabId?: string): void {
    try {
      requestBrowserSurface(sessionId, true, { error, tabId });
    } catch {
      /* the window is gone: the tool reply still carries the failure */
    }
  }

  return { requestBrowserSurface, revealPage, reportOpenFailure };
}
