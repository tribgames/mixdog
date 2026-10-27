/**
 * The live-view sender window's own session. The window runs getUserMedia for
 * the whole-PC screen (`chromeMediaSource: 'desktop'`), which Electron asks
 * the session's permission handler to allow as `media`. The app's default
 * session grants `media` to routed app windows only, so the sender gets a
 * non-persistent partition of its own whose handlers allow exactly that one
 * request: video-only media from the sender's own page. Everything else —
 * audio, every other permission, every permission check, other contents and
 * other pages — is denied. The default session's policy is left as it is.
 */
import { pathToFileURL } from 'node:url';

import type { Session } from 'electron';

/** No `persist:` prefix: the partition lives in memory and leaves nothing on disk. */
export const REMOTE_WEBRTC_SENDER_PARTITION = 'mixdog-live-view-sender';

/** Load target of the sender page: the dev server's, or the built file. */
export interface RemoteWebrtcSenderPage {
  developmentUrl?: string;
  /** Absolute path of the built remote-webrtc-sender.html. */
  file: string;
}

/** The one document the sender window loads. */
export function remoteWebrtcSenderPageUrl(page: RemoteWebrtcSenderPage): string {
  return page.developmentUrl
    ? new URL('remote-webrtc-sender.html', page.developmentUrl).href
    : pathToFileURL(page.file).href;
}

const withoutQueryOrHash = (value: string): string | null => {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
};

export interface RemoteWebrtcSenderPermissionRequest {
  permission: string;
  /** The contents that asked. */
  sender: unknown;
  /** The sender window's own contents (null: none, or destroyed). */
  own: unknown;
  /** `details.mediaTypes` of the request. */
  mediaTypes?: readonly string[];
  /** `details.requestingUrl` of the request. */
  requestingUrl?: string;
  isMainFrame?: boolean;
}

/** Whether the sender window may be granted this permission request: `media`,
 *  from its own contents' main frame on its own page, for video only. A desktop
 *  capture (`chromeMediaSource: 'desktop'`) reports an empty `mediaTypes`
 *  (Electron lists only camera/microphone devices), so the list must be there
 *  and must not name `audio`; it need not name `video`.
 *
 *  Residual, accepted: for that same reason desktop audio capture cannot be
 *  told apart from desktop video at this layer. It is acceptable only because
 *  the requester is this app's own protected page: its own contents, main
 *  frame and document, under a closed CSP (no remote script, no inline or
 *  eval script, no connection out) that the page cannot be talked out of. The
 *  page itself never asks for audio. */
export function remoteWebrtcSenderPermissionAllowed(
  request: RemoteWebrtcSenderPermissionRequest,
  page: RemoteWebrtcSenderPage
): boolean {
  const { mediaTypes, requestingUrl } = request;
  return (
    request.permission === 'media' &&
    request.own != null &&
    request.sender === request.own &&
    request.isMainFrame === true &&
    Array.isArray(mediaTypes) &&
    !mediaTypes.includes('audio') &&
    typeof requestingUrl === 'string' &&
    withoutQueryOrHash(requestingUrl) === withoutQueryOrHash(remoteWebrtcSenderPageUrl(page))
  );
}

/** The sender page's CSP while the Vite dev server serves it (http): its HMR
 *  client needs eval, inline scripts and the dev socket. The built page's
 *  policy is a meta tag stamped into the document at build time
 *  (scripts/remote-webrtc-sender-csp.mjs), so the header is sent for the dev
 *  page only. */
export const REMOTE_WEBRTC_SENDER_DEVELOPMENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; style-src 'self' 'unsafe-inline'";

type SenderSession = Pick<
  Session,
  'setDevicePermissionHandler' | 'setPermissionCheckHandler' | 'setPermissionRequestHandler'
> & { webRequest: Pick<Session['webRequest'], 'onHeadersReceived'> };

/** Installs the sender policy on its partition. `ownContents` is read at
 *  request time: the window is recreated after a crash. */
export function installRemoteWebrtcSenderSession(
  target: SenderSession,
  page: RemoteWebrtcSenderPage,
  ownContents: () => unknown
): void {
  if (page.developmentUrl) {
    const pageUrl = withoutQueryOrHash(remoteWebrtcSenderPageUrl(page));
    target.webRequest.onHeadersReceived((details, callback) => {
      // Only the sender's own document carries the policy.
      if (withoutQueryOrHash(details.url) !== pageUrl) {
        callback({});
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [REMOTE_WEBRTC_SENDER_DEVELOPMENT_CSP],
        },
      });
    });
  }
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      remoteWebrtcSenderPermissionAllowed(
        {
          permission,
          sender: webContents,
          own: ownContents(),
          mediaTypes: (details as { mediaTypes?: readonly string[] }).mediaTypes,
          requestingUrl: details.requestingUrl,
          isMainFrame: details.isMainFrame,
        },
        page
      )
    );
  });
}
