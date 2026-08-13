export const REMOTE_PAIRING_STORAGE_KEYS = {
  token: 'mixdog.remote-token',
  server: 'mixdog.remote-server',
  paired: 'mixdog.remote-paired',
  e2eePublicKey: 'mixdog.remote-e2ee-public-key',
  e2eeSecret: 'mixdog.remote-e2ee-secret',
} as const;

export interface ParsedRemotePairingLink {
  url: string;
  origin: string;
  token: string;
  serverPublicKey: string;
  pairingSecret: string;
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

export function parseRemotePairingLink(value: string): ParsedRemotePairingLink | null {
  try {
    const link = new URL(String(value || '').trim());
    const origin = normalizeRemoteRelayOrigin(link.toString());
    if (!origin) return null;
    const fragment = new URLSearchParams(link.hash.replace(/^#/u, ''));
    const token = link.searchParams.get('token') || '';
    const serverPublicKey = fragment.get('e2eeKey') || link.searchParams.get('e2eeKey') || '';
    const pairingSecret = fragment.get('e2eeSecret') || link.searchParams.get('e2eeSecret') || '';
    if (
      !/^[0-9a-f]{32,128}$/u.test(token)
      || !/^[A-Za-z0-9_-]{87}$/u.test(serverPublicKey)
      || !/^[A-Za-z0-9_-]{43}$/u.test(pairingSecret)
    ) return null;
    return {
      url: link.toString(),
      origin,
      token,
      serverPublicKey,
      pairingSecret,
    };
  } catch {
    return null;
  }
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
  if (event.code === 4003) return true;
  if (event.code !== 4004) return false;
  return /relay encryption (?:handshake (?:required|timed out)|authentication failed)|invalid encrypted relay frame/iu
    .test(event.reason);
}

export function clearStoredRemotePairing(
  storage: Pick<Storage, 'removeItem'>,
): void {
  for (const key of Object.values(REMOTE_PAIRING_STORAGE_KEYS)) storage.removeItem(key);
}
