import { DESKTOP_IPC, MAIN_BROWSER_PAGE_PREFIX, type DesktopBrowserViewportConfig } from '../shared/contract';
import { requiredSessionId } from './desktop-state';
import type { BrowserHost } from './browser/host';
import type { IpcHandle as Handle } from './ipc';
import { normalizeBrowserPageControl } from '../shared/browser-page-control';
import {
  normalizeBrowserCredentialId,
  normalizeBrowserHistoryQuery,
  normalizeBrowserImportRequest,
} from '../shared/remote-browser';

interface BrowserIpcOptions {
  handle: Handle;
  browserHost?: Pick<
    BrowserHost,
    | 'browserImportSources'
    | 'browserImport'
    | 'browserHistorySearch'
    | 'setGuestActive'
    | 'releaseSession'
    | 'configureGuestViewport'
    | 'browserCredentialSuggestions'
    | 'browserCredentialFill'
    | 'browserPageFrame'
    | 'browserPageControl'
    | 'browserPageMetadata'
    | 'browserPresentNative'
  >;
}

/** A pane rectangle in shell CSS pixels, or null to park the page. */
function nativeRect(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Browser native rectangle is invalid.');
  }
  const { x, y, width, height } = value as Record<string, unknown>;
  const rect = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.x + rect.width > 16_384 ||
    rect.y + rect.height > 16_384
  ) {
    throw new TypeError('Browser native rectangle is invalid.');
  }
  return rect;
}

function requiredGuestId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError('Browser guest id is invalid.');
  }
  return Number(value);
}

export function registerBrowserIpc({ handle, browserHost }: BrowserIpcOptions): void {
  // Main-tab page ids are unique per tab instance. Once released, a late frame
  // or control request (still queued in the renderer, or already awaiting page
  // creation) must not recreate the page, so the id stays closed.
  const releasedPages = new Set<string>();
  const live = (pageId: string) => {
    if (releasedPages.has(pageId)) throw new Error('Browser page was closed.');
  };
  const guarded = async <T>(pageId: string, work: () => Promise<T>): Promise<T> => {
    live(pageId);
    const result = await work();
    if (releasedPages.has(pageId)) {
      // Released while the request was creating the page: drop what it made.
      browserHost?.releaseSession(pageId);
      throw new Error('Browser page was closed.');
    }
    return result;
  };
  handle(DESKTOP_IPC.browserPageFrame, (_event, sessionId, previousId, texture) => {
    if (!browserHost) throw new Error('Browser Use is unavailable.');
    if (previousId !== undefined && (typeof previousId !== 'string' || previousId.length > 160)) {
      throw new TypeError('Browser frame id is invalid.');
    }
    if (texture !== undefined && typeof texture !== 'boolean') throw new TypeError('Browser texture mode is invalid.');
    const pageId = requiredSessionId(sessionId);
    return guarded(pageId, () =>
      browserHost.browserPageFrame(pageId, previousId as string | undefined, texture === true)
    );
  });
  handle(DESKTOP_IPC.browserPageControl, (_event, sessionId, input) => {
    if (!browserHost) throw new Error('Browser Use is unavailable.');
    const pageId = requiredSessionId(sessionId);
    live(pageId);
    const control = normalizeBrowserPageControl(input);
    return guarded(pageId, async () => browserHost.browserPageControl(pageId, control));
  });
  handle(DESKTOP_IPC.browserPageMetadata, (_event, sessionId) => {
    if (!browserHost) throw new Error('Browser Use is unavailable.');
    const pageId = requiredSessionId(sessionId);
    return guarded(pageId, () => browserHost.browserPageMetadata(pageId));
  });
  handle(DESKTOP_IPC.browserPresentNative, (_event, sessionId, rect) => {
    if (!browserHost) return { enabled: false, shown: false };
    return browserHost.browserPresentNative(requiredSessionId(sessionId), nativeRect(rect));
  });
  handle(DESKTOP_IPC.browserSetActiveGuest, (_event, sessionId, webContentsId, active) => {
    if (!browserHost) throw new Error('Browser Use is unavailable in this app surface.');
    const ownerSessionId = requiredSessionId(sessionId);
    const guestId = requiredGuestId(webContentsId);
    if (typeof active !== 'boolean') throw new TypeError('Browser guest activity is invalid.');
    browserHost.setGuestActive(ownerSessionId, guestId, active);
  });
  // The renderer may only release pages it owns: main-workspace browser tabs.
  // A conversation's own page belongs to the agent's session lifecycle.
  handle(DESKTOP_IPC.browserReleasePage, (_event, sessionId) => {
    if (!browserHost) return;
    const pageId = requiredSessionId(sessionId);
    if (!pageId.startsWith(MAIN_BROWSER_PAGE_PREFIX)) throw new TypeError('Browser page is not a main tab page.');
    releasedPages.add(pageId);
    browserHost.releaseSession(pageId);
  });
  handle(DESKTOP_IPC.browserConfigureGuestViewport, (_event, sessionId, webContentsId, value) => {
    if (!browserHost) throw new Error('Browser Use is unavailable in this app surface.');
    const ownerSessionId = requiredSessionId(sessionId);
    const guestId = requiredGuestId(webContentsId);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Browser viewport config is invalid.');
    }
    const input = value as Record<string, unknown>;
    const { width, height } = input;
    const fixedViewport = width !== null && height !== null;
    if (
      (width === null) !== (height === null) ||
      (fixedViewport &&
        (!Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) ||
          Number(width) < 200 ||
          Number(width) > 3840 ||
          Number(height) < 200 ||
          Number(height) > 3840))
    ) {
      throw new TypeError('Browser viewport dimensions are invalid.');
    }
    const deviceScaleFactor = Number(input.deviceScaleFactor);
    if (
      !Number.isFinite(deviceScaleFactor) ||
      deviceScaleFactor < 0.5 ||
      deviceScaleFactor > 4 ||
      typeof input.mobile !== 'boolean' ||
      typeof input.touch !== 'boolean'
    ) {
      throw new TypeError('Browser viewport emulation is invalid.');
    }
    const userAgent = input.userAgent;
    if (userAgent !== null && (typeof userAgent !== 'string' || userAgent.length > 2048 || /[\r\n]/.test(userAgent))) {
      throw new TypeError('Browser viewport user agent is invalid.');
    }
    const config: DesktopBrowserViewportConfig = {
      width: width === null ? null : Number(width),
      height: height === null ? null : Number(height),
      deviceScaleFactor,
      mobile: input.mobile,
      touch: input.touch,
      userAgent,
    };
    return browserHost.configureGuestViewport(ownerSessionId, guestId, config);
  });
  handle(DESKTOP_IPC.browserProfileImportSources, () => {
    if (!browserHost) throw new Error('Browser profile import is unavailable in this app surface.');
    return browserHost.browserImportSources();
  });
  handle(DESKTOP_IPC.browserProfileImportStart, (_event, value) => {
    if (!browserHost) throw new Error('Browser profile import is unavailable in this app surface.');
    return browserHost.browserImport(normalizeBrowserImportRequest(value));
  });
  handle(DESKTOP_IPC.browserHistorySearch, (_event, query) => {
    if (!browserHost) throw new Error('Browser history is unavailable in this app surface.');
    return browserHost.browserHistorySearch(normalizeBrowserHistoryQuery(query));
  });
  handle(DESKTOP_IPC.browserCredentialSuggestions, (_event, sessionId) => {
    if (!browserHost) throw new Error('Stored browser credentials are unavailable in this app surface.');
    return browserHost.browserCredentialSuggestions(requiredSessionId(sessionId));
  });
  handle(DESKTOP_IPC.browserCredentialFill, (_event, sessionId, credentialId) => {
    if (!browserHost) throw new Error('Stored browser credentials are unavailable in this app surface.');
    return browserHost.browserCredentialFill(requiredSessionId(sessionId), normalizeBrowserCredentialId(credentialId));
  });
}
