// Page half of the encrypted media lane. The relay serves media as ciphertext;
// public/sw-media.js turns <img>/<video>/<audio> requests back into playable
// 200/206 responses. This file gives the worker the session's media key (a
// non-extractable CryptoKey derived in the E2EE handshake, posted to the worker
// only — never to a server) and builds the URLs the worker recognizes.
import { MEDIA_SCHEME } from '../shared/remote-media-crypto';

const KEY_MESSAGE = 'mixdog:media-key';
const KEY_REVOKE_MESSAGE = 'mixdog:media-key-revoke';
const KEY_REQUEST_MESSAGE = 'mixdog:media-key-request';

// Keys of live sessions, kept so a restarted worker can ask for them again.
const sessionKeys = new Map<string, CryptoKey>();
let listening = false;

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

/** Makes `key` available to the service worker for URLs labelled `sid`. */
export function publishMediaKey(sid: string, key: CryptoKey): void {
  sessionKeys.set(sid, key);
  listenForKeyRequests();
  controller()?.postMessage({ type: KEY_MESSAGE, sid, key });
}

/** The session ended: neither this page nor the worker may keep its key. */
export function revokeMediaKey(sid: string): void {
  sessionKeys.delete(sid);
  controller()?.postMessage({ type: KEY_REVOKE_MESSAGE, sid });
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
