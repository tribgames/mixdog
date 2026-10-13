// Page half of the encrypted media lane. The relay serves media as ciphertext;
// public/sw-media.js turns <img>/<video>/<audio> requests back into playable
// 200/206 responses. This file gives the worker the session's media key (a
// non-extractable CryptoKey derived in the E2EE handshake, posted to the worker
// only — never to a server) and builds the URLs the worker recognizes.
import { FILE_DOWNLOAD_MEDIA_VARIANT, type FileDownloadTransfer } from '../shared/file-downloads';
import { MEDIA_SCHEME } from '../shared/remote-media-crypto';

const KEY_MESSAGE = 'mixdog:media-key';
const KEY_REVOKE_MESSAGE = 'mixdog:media-key-revoke';
const KEY_REQUEST_MESSAGE = 'mixdog:media-key-request';
/** Worker-only download route (public/sw-media.js). The relay never serves
 *  it, so a navigation the worker did not take can never come back as
 *  ciphertext handed to the browser's downloader. */
const DOWNLOAD_PATH = '/__mixdog-download__/';
const LEASE_ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[A-Za-z0-9_-]{43}$/;

/** Where the current session's lane reaches its host. */
export interface MediaLaneRoute {
  /** The relay origin the page talks to; the worker only reaches its own. */
  base: string;
  /** The pairing credential the relay authorizes media requests with. */
  token: () => string;
}

// Keys of live sessions, kept so a restarted worker can ask for them again.
const sessionKeys = new Map<string, CryptoKey>();
let listening = false;
// The session the newest key belongs to: downloads are leased on it.
let laneSession: { sid: string; route: MediaLaneRoute } | null = null;

function controller(): ServiceWorker | null {
  return typeof navigator === 'undefined' ? null : (navigator.serviceWorker?.controller ?? null);
}

function listenForKeyRequests(): void {
  if (listening || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  listening = true;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; sid?: unknown } | null;
    if (data?.type !== KEY_REQUEST_MESSAGE || typeof data.sid !== 'string') return;
    const key = sessionKeys.get(data.sid);
    if (key) controller()?.postMessage({ type: KEY_MESSAGE, sid: data.sid, key });
  });
}

/** Makes `key` available to the service worker for URLs labelled `sid`.
 *  `route` enables download URLs (fileDownloadLaneUrl) for this session. */
export function publishMediaKey(sid: string, key: CryptoKey, route?: MediaLaneRoute): void {
  sessionKeys.set(sid, key);
  laneSession = route ? { sid, route } : null;
  listenForKeyRequests();
  controller()?.postMessage({ type: KEY_MESSAGE, sid, key });
}

/** The session ended: neither this page nor the worker may keep its key. */
export function revokeMediaKey(sid: string): void {
  sessionKeys.delete(sid);
  if (laneSession?.sid === sid) laneSession = null;
  controller()?.postMessage({ type: KEY_REVOKE_MESSAGE, sid });
}

/**
 * Same-origin URL that downloads a media-lane transfer lease through the
 * service worker (navigate or anchor-click it; a `Range` fetch of it resumes
 * from a byte offset), or null when the lane is unavailable: an older host
 * (no `media` lease), no controlling worker, or no media key / route for the
 * current session. The worker checks every window against the transfer's
 * size and version and serves the decrypted bytes as an attachment.
 */
export function fileDownloadLaneUrl(transfer: FileDownloadTransfer): string | null {
  const media = transfer.media;
  const session = laneSession;
  if (!media || media.variant !== FILE_DOWNLOAD_MEDIA_VARIANT || !session || !controller()) return null;
  if (typeof location === 'undefined' || session.route.base !== location.origin) return null;
  if (!sessionKeys.has(session.sid) || !LEASE_ASSET_ID.test(media.assetId) || !VERSION.test(transfer.version)) {
    return null;
  }
  if (!Number.isSafeInteger(transfer.size) || transfer.size < 0) return null;
  const query = new URLSearchParams({
    sid: session.sid,
    enc: MEDIA_SCHEME,
    v: transfer.version,
    size: String(transfer.size),
    name: transfer.name,
  });
  const token = session.route.token();
  if (token) query.set('token', token);
  return `${location.origin}${DOWNLOAD_PATH}${media.assetId}?${query.toString()}`;
}

/** The lane needs the host's capability AND a worker controlling this page. */
export function mediaLaneSupported(peerMediaE2ee: boolean): boolean {
  return peerMediaE2ee && controller() !== null;
}

/**
 * URL for an asset on the encrypted lane, or '' when it is unavailable (an
 * older host, no controlling worker, no session key yet): callers keep their
 * RPC path. `healthz` is the plain feature probe the relay answers itself.
 */
export function remoteMediaLaneUrl(input: {
  base: string;
  token: string | null;
  sid: string | null;
  supported: boolean;
  assetId: string;
  variant?: string;
}): string {
  if (!input.supported) return '';
  const isProbe = input.assetId === 'healthz';
  if (!isProbe && !input.sid) return '';
  const query = [`variant=${encodeURIComponent(input.variant || 'original')}`];
  // `enc` opts into the encrypted protocol; the host answers requests
  // without it as if the media did not exist.
  if (!isProbe && input.sid) query.push(`sid=${encodeURIComponent(input.sid)}`, `enc=${MEDIA_SCHEME}`);
  if (input.token) query.push(`token=${encodeURIComponent(input.token)}`);
  return `${input.base}/media/${encodeURIComponent(input.assetId)}?${query.join('&')}`;
}
