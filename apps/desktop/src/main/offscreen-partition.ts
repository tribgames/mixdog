import type { OnCompletedListenerDetails, OnErrorOccurredListenerDetails, Session } from 'electron';

import { type OffscreenOrigins, offscreenOrigins } from './visualize/offscreen-origins';

/** One non-persistent partition shared by off-screen visualize renders and file snapshots. */
export const OFFSCREEN_PARTITION = 'mixdog-offscreen';
/** Dedicated non-persistent partition for proxied off-screen HTTP fetches, isolated from
 *  `session.defaultSession` and separate from `OFFSCREEN_PARTITION`'s per-window request filter. */
export const OFFSCREEN_FETCH_PARTITION = 'mixdog-offscreen-fetch';

/** What a frame from another origin runs under: everything but its origin. */
const FOREIGN_FRAME_POLICY = 'sandbox allow-scripts allow-forms allow-modals allow-pointer-lock allow-presentation';

export interface OffscreenRenderHooks {
  origin: string;
  admit(details: { id: number; url: string }): boolean;
  settled?(details: OnCompletedListenerDetails | OnErrorOccurredListenerDetails): void;
}

export interface SharedOffscreenPartition {
  session: Session;
  origins: OffscreenOrigins;
  register(webContentsId: number, hooks: OffscreenRenderHooks): () => void;
  fetch(input: string | Request, init?: RequestInit & { bypassCustomProtocolHandlers?: boolean }): Promise<Response>;
}

const without = <T>(headers: Record<string, T>, name: string): Record<string, T> =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== name));

let sharedPartition: SharedOffscreenPartition | null = null;

/** Lazily creates and returns the single non-persistent off-screen partition. */
export function getSharedOffscreenPartition(
  electronSession: typeof import('electron').session,
  _electronNet?: typeof import('electron').net
): SharedOffscreenPartition {
  if (sharedPartition) return sharedPartition;
  const shared = electronSession.fromPartition(OFFSCREEN_PARTITION, { cache: false });
  const fetchSession = electronSession.fromPartition(OFFSCREEN_FETCH_PARTITION, { cache: false });
  const renders = new Map<number, OffscreenRenderHooks>();
  const renderOf = (webContentsId: number | undefined) =>
    webContentsId === undefined ? undefined : renders.get(webContentsId);

  shared.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !renderOf(details.webContentsId)?.admit(details) });
  });
  shared.webRequest.onBeforeSendHeaders?.({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ requestHeaders: without(details.requestHeaders, 'cookie') });
  });
  shared.webRequest.onHeadersReceived?.({ urls: ['<all_urls>'] }, (details, callback) => {
    const responseHeaders = without(details.responseHeaders ?? {}, 'set-cookie');
    const own = renderOf(details.webContentsId)?.origin;
    if (details.resourceType === 'subFrame' && (own === undefined || new URL(details.url).origin !== own)) {
      const policy = Object.keys(responseHeaders).find((key) => key.toLowerCase() === 'content-security-policy');
      responseHeaders[policy ?? 'Content-Security-Policy'] = [
        ...(policy ? responseHeaders[policy] : []),
        FOREIGN_FRAME_POLICY,
      ];
    }
    callback({ responseHeaders });
  });
  shared.webRequest.onCompleted?.({ urls: ['<all_urls>'] }, (details) =>
    renderOf(details.webContentsId)?.settled?.(details)
  );
  shared.webRequest.onErrorOccurred?.({ urls: ['<all_urls>'] }, (details) =>
    renderOf(details.webContentsId)?.settled?.(details)
  );
  shared.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  shared.setPermissionCheckHandler(() => false);

  fetchSession.webRequest?.onBeforeSendHeaders?.({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ requestHeaders: without(details.requestHeaders, 'cookie') });
  });
  fetchSession.webRequest?.onHeadersReceived?.({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ responseHeaders: without(details.responseHeaders ?? {}, 'set-cookie') });
  });
  fetchSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  fetchSession.setPermissionCheckHandler(() => false);

  const fetchUncached: SharedOffscreenPartition['fetch'] = (input, init) =>
    fetchSession.fetch(input, { ...init, cache: 'no-store', credentials: 'omit', bypassCustomProtocolHandlers: true });

  const origins = offscreenOrigins(shared, (request) => fetchUncached(request));

  sharedPartition = {
    session: shared,
    origins,
    register(webContentsId, hooks) {
      renders.set(webContentsId, hooks);
      return () => {
        if (renders.get(webContentsId) === hooks) renders.delete(webContentsId);
      };
    },
    fetch: fetchUncached,
  };
  return sharedPartition;
}
