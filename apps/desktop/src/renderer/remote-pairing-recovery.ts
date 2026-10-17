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
  // An approval already waiting on the desktop, with the throwaway key it will
  // be sealed to. A phone OS discards a backgrounded web app freely; without
  // this the reloaded app would ask again and the user would face prompt after
  // prompt for one connection.
  claim: 'mixdog.remote-claim',
  // When an approval last succeeded here. A credential rejected right after one
  // is a real failure, not something to paper over by asking again in a loop.
  approvedAt: 'mixdog.remote-approved-at',
  // Which linked file (path and conversation) each held file-grant token
  // names, so a token restored after a reload can be granted again.
  fileGrants: 'mixdog.remote-file-grants',
} as const;

/** Per-PC pairing state. Everything here belongs to ONE desktop on ONE relay
 *  origin; `server` and `device` stay origin-wide as routing labels. */
const SCOPED_PAIRING_NAMES = [
  'token',
  'server',
  'paired',
  'browserId',
  'e2eePublicKey',
  'e2eeSecret',
  'claim',
  'approvedAt',
  'fileGrants',
] as const;

export type RemotePairingKeys = Record<keyof typeof REMOTE_PAIRING_STORAGE_KEYS, string>;

/** The storage keys for one relay origin + device. The PC switcher moves
 *  between /d/<deviceId>/ routes on one origin, so a credential is only ever
 *  read under the key of the device it was approved for. Without a device id
 *  (no route yet) the unscoped keys apply. */
export function remotePairingKeys(origin: string, deviceId: string): RemotePairingKeys {
  if (!deviceId) return { ...REMOTE_PAIRING_STORAGE_KEYS };
  const keys: RemotePairingKeys = { ...REMOTE_PAIRING_STORAGE_KEYS };
  for (const name of SCOPED_PAIRING_NAMES) {
    keys[name] = `${REMOTE_PAIRING_STORAGE_KEYS[name]}@${encodeURIComponent(origin)}/${deviceId}`;
  }
  return keys;
}

/** Move credentials written before pairing was namespaced to the device they
 *  were stored for (the legacy `device` label) — never to whichever route is
 *  open now. Nothing is moved when the label is missing or the target already
 *  holds its own token. */
export function migrateLegacyRemotePairing(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  origin: string
): void {
  const legacy = REMOTE_PAIRING_STORAGE_KEYS;
  const owner = storage.getItem(legacy.device) || '';
  if (!REMOTE_DEVICE_ID.test(owner) || !storage.getItem(legacy.token)) return;
  const target = remotePairingKeys(origin, owner);
  if (!storage.getItem(target.token)) {
    for (const name of SCOPED_PAIRING_NAMES) {
      const value = storage.getItem(legacy[name]);
      if (value !== null) storage.setItem(target[name], value);
    }
  }
  for (const name of SCOPED_PAIRING_NAMES) storage.removeItem(legacy[name]);
}

const REMOTE_DEVICE_ID = /^[0-9a-f-]{8,64}$/u;
const REMOTE_CLIENT_CREDENTIAL = /^[0-9a-f]{32,128}$/u;
const DEVICE_COOKIE_NAME = 'mixdog_device';

/** The per-browser credential format the relay mints on registration and approval. */
export function isRemoteClientCredential(value: string): boolean {
  return REMOTE_CLIENT_CREDENTIAL.test(value);
}

/** A pairing that has completed one E2EE WebSocket handshake already owns a
 * per-browser credential. Dial it directly; the relay's 4003/4005 close path
 * remains the authoritative revoked/stale-credential check. */
export function canReuseStoredRemoteClientRegistration({
  everPaired,
  token,
  hasE2eePairing,
}: {
  everPaired: boolean;
  token: string;
  hasE2eePairing: boolean;
}): boolean {
  return everPaired && hasE2eePairing && isRemoteClientCredential(token);
}

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

export function isInvalidRemotePairingClose(event: Pick<CloseEvent, 'code' | 'reason'>): boolean {
  // 4003: pairing/device revoked. 4005: relay v2 refused a stale or legacy
  // shared token — only pairing again recovers either, by a fresh QR scan or
  // a new six-digit code.
  if (event.code === 4003 || event.code === 4005) return true;
  if (event.code !== 4004) return false;
  // 4004 is a generic desktop rejection; only real authentication failures
  // drop the pairing. A handshake TIMEOUT is transient (busy desktop), and so
  // is "handshake required": an older PC sends it for ciphertext a phone had
  // in flight while that PC redialed.
  return /relay encryption authentication failed|invalid encrypted relay frame/iu.test(event.reason);
}

export function clearStoredRemotePairing(
  storage: Pick<Storage, 'removeItem'>,
  keys: RemotePairingKeys = REMOTE_PAIRING_STORAGE_KEYS
): void {
  for (const key of Object.values(keys)) storage.removeItem(key);
}
