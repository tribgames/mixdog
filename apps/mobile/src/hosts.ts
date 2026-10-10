// Pairing links and the hosts this phone remembers. Pure (no Capacitor), so
// the rules are unit-tested. The link rules mirror
// apps/desktop/src/main/remote-hosts.ts `parseRemoteHostLink`: a link carries a
// ROUTE (`/d/<deviceId>/`), never a credential; plain http is loopback-only.

const DEVICE_ROUTE = /^\/d\/((?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|[0-9a-f]{32,64})\/?$/iu;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const MAX_SAVED_HOSTS = 16;

export interface PairedHost {
  /** Canonical link: origin + device route. */
  url: string;
  deviceId: string;
  name: string;
  lastOpenedAt: number;
}

export interface HostBook {
  hosts: PairedHost[];
  /** URL of the host to open at launch. */
  last: string;
}

export function parsePairingLink(text: unknown): { url: string; deviceId: string } | null {
  let url: URL;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return null;
  if (url.username || url.password) return null;
  const route = DEVICE_ROUTE.exec(url.pathname);
  if (!route) return null;
  const deviceId = route[1].toLowerCase();
  return { url: `${url.origin}/d/${deviceId}/`, deviceId };
}

export function defaultHostName(link: { url: string; deviceId: string }): string {
  return `${new URL(link.url).host} · ${link.deviceId.slice(0, 8)}`;
}

export const emptyHostBook = (): HostBook => ({ hosts: [], last: '' });

/** Remember (or refresh) a host and make it the launch target. */
export function rememberHost(book: HostBook, link: { url: string; deviceId: string }, now: number): HostBook {
  const existing = book.hosts.find((host) => host.url === link.url);
  const entry: PairedHost = {
    url: link.url,
    deviceId: link.deviceId,
    name: existing?.name ?? defaultHostName(link),
    lastOpenedAt: now,
  };
  const hosts = [entry, ...book.hosts.filter((host) => host.url !== link.url)].slice(0, MAX_SAVED_HOSTS);
  return { hosts, last: link.url };
}

export function forgetHost(book: HostBook, url: string): HostBook {
  const hosts = book.hosts.filter((host) => host.url !== url);
  return { hosts, last: book.last === url ? '' : book.last };
}

/** Tolerant load: anything unexpected in storage yields an empty book. */
export function readHostBook(raw: string | null | undefined): HostBook {
  try {
    const parsed = JSON.parse(raw || '') as { hosts?: unknown; last?: unknown };
    const hosts: PairedHost[] = [];
    for (const item of Array.isArray(parsed.hosts) ? parsed.hosts : []) {
      const link = parsePairingLink((item as { url?: unknown })?.url);
      if (!link || hosts.some((host) => host.url === link.url)) continue;
      const name = (item as { name?: unknown }).name;
      hosts.push({
        ...link,
        name: typeof name === 'string' && name ? name.slice(0, 80) : defaultHostName(link),
        lastOpenedAt: Number((item as { lastOpenedAt?: unknown }).lastOpenedAt) || 0,
      });
    }
    const last = typeof parsed.last === 'string' && hosts.some((host) => host.url === parsed.last) ? parsed.last : '';
    return { hosts: hosts.slice(0, MAX_SAVED_HOSTS), last };
  } catch {
    return emptyHostBook();
  }
}

/** The pairing link inside a scanned QR payload or pasted text (the desktop
 *  may wrap it in whitespace or a sentence). */
export function extractPairingLink(text: string): { url: string; deviceId: string } | null {
  const direct = parsePairingLink(text);
  if (direct) return direct;
  for (const token of String(text).split(/\s+/u)) {
    const link = parsePairingLink(token);
    if (link) return link;
  }
  return null;
}
