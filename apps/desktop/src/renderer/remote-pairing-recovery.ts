export const REMOTE_PAIRING_STORAGE_KEYS = {
  token: 'mixdog.remote-token',
  server: 'mixdog.remote-server',
  paired: 'mixdog.remote-paired',
  browserId: 'mixdog.remote-browser-id',
  e2eePublicKey: 'mixdog.remote-e2ee-public-key',
  e2eeSecret: 'mixdog.remote-e2ee-secret',
  // Which desktop this container belongs to. A routing label, never a
  // credential: the installed app launches at /d/<deviceId>/ and needs it to
  // know whom to ask for approval.
  device: 'mixdog.remote-device',
} as const;

const REMOTE_DEVICE_ID = /^[0-9a-f-]{8,64}$/u;
const DEVICE_COOKIE_NAME = 'mixdog_device';

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function normalizeRemoteRelayOrigin(value: string): string {
  try {
    const url = new URL(String(value || '').trim());
    if (url.username || url.password) return '';
    if (url.protocol === 'https:') return url.origin;
    if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url.origin;
  } catch {
    // Invalid stored or scanned URL.
  }
  return '';
}

/** Which desktop to ask for approval: the /d/<deviceId>/ route this container
 *  was launched at, or the cookie the relay set for it when a navigation
 *  landed outside that route. Neither is a credential — approval is. */
export function readRemoteDeviceId(pathname: string, cookie: string): string {
  const routed = /^\/d\/([0-9a-f-]{8,64})(?:\/|$)/u.exec(String(pathname || ''));
  if (routed) return routed[1];
  for (const part of String(cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0 || part.slice(0, eq).trim() !== DEVICE_COOKIE_NAME) continue;
    try {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return REMOTE_DEVICE_ID.test(value) ? value : '';
    } catch {
      return '';
    }
  }
  return '';
}

export function normalizeRemoteExternalUrl(value: string): string {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function isInvalidRemotePairingClose(
  event: Pick<CloseEvent, 'code' | 'reason'>,
): boolean {
  // 4003: pairing/device revoked. 4005: relay v2 refused a stale or legacy
  // shared token — only a fresh QR scan recovers either.
  if (event.code === 4003 || event.code === 4005) return true;
  if (event.code !== 4004) return false;
  // 4004 is a generic desktop rejection; only permanent E2EE failures drop the
  // pairing. A handshake TIMEOUT is transient (busy desktop) and reconnects.
  return /relay encryption (?:handshake required|authentication failed)|invalid encrypted relay frame/iu
    .test(event.reason);
}

export function clearStoredRemotePairing(
  storage: Pick<Storage, 'removeItem'>,
): void {
  for (const key of Object.values(REMOTE_PAIRING_STORAGE_KEYS)) storage.removeItem(key);
}
