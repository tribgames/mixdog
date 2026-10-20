// Pairing links and the hosts this phone remembers. Pure (no Capacitor), so
// the rules are unit-tested. The link rules mirror
// apps/desktop/src/main/remote-hosts.ts `parseRemoteHostLink`: a link carries a
// ROUTE (`/d/<deviceId>/`), never a credential; plain http is loopback-only.

const DEVICE_ROUTE = /^\/d\/((?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|[0-9a-f]{32,64})\/?$/iu;
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
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

function defaultHostName(link: { url: string; deviceId: string }): string {
  return `${new URL(link.url).host} · ${link.deviceId.slice(0, 8)}`;
}

export const emptyHostBook = (): HostBook => ({ hosts: [], last: '' });

/** Remember (or refresh) a host and make it the launch target. `name` is the
 *  host's own name for itself when it told us (6-digit code). */
export function rememberHost(
  book: HostBook,
  link: { url: string; deviceId: string },
  now: number,
  name = ''
): HostBook {
  const existing = book.hosts.find((host) => host.url === link.url);
  const entry: PairedHost = {
    url: link.url,
    deviceId: link.deviceId,
    name: name.trim().slice(0, 80) || existing?.name || defaultHostName(link),
    lastOpenedAt: now,
  };
  const hosts = [entry, ...book.hosts.filter((host) => host.url !== link.url)].slice(0, MAX_SAVED_HOSTS);
  return { hosts, last: link.url };
}

export function forgetHost(book: HostBook, url: string): HostBook {
  const hosts = book.hosts.filter((host) => host.url !== url);
  return { hosts, last: book.last === url ? '' : book.last };
}

/** How long a launch waits for the relays to say which PCs are online. */
export const PRESENCE_TIMEOUT_MS = 3_000;

/** Which saved hosts have their PC connected to the relay right now, by host
 *  URL: one request per relay origin. A relay that cannot answer (offline,
 *  too old, throttled) leaves its hosts out — unknown, not offline. Mirrors
 *  apps/desktop/src/main/remote-hosts.ts `fetchHostPresence`. */
export async function fetchHostPresence(
  hosts: PairedHost[],
  doFetch: typeof fetch = fetch
): Promise<Map<string, boolean>> {
  const byOrigin = new Map<string, PairedHost[]>();
  for (const host of hosts) {
    const origin = new URL(host.url).origin;
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), host]);
  }
  const online = new Map<string, boolean>();
  await Promise.all(
    [...byOrigin].map(async ([origin, group]) => {
      try {
        const response = await doFetch(`${origin}/pair-code/presence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: group.map((host) => host.deviceId) }),
          signal: AbortSignal.timeout(PRESENCE_TIMEOUT_MS),
        });
        if (!response.ok) return;
        const body = (await response.json()) as { online?: unknown };
        if (!body.online || typeof body.online !== 'object') return;
        const states = body.online as Record<string, unknown>;
        for (const host of group) online.set(host.url, states[host.deviceId] === true);
      } catch {
        /* unreachable relay: state unknown */
      }
    })
  );
  return online;
}

/** The PC to open at launch, or '' for the saved-PC list. A single saved PC
 *  opens at once, as always (no network wait). With more than one, the last
 *  PC opens unless its relay says it is offline — then the list is the first
 *  screen, so an offline PC never holds the app on an endless load while
 *  another one is up. A relay that cannot answer keeps the last PC. */
export async function launchTarget(
  book: HostBook,
  presence: () => Promise<Map<string, boolean>>
): Promise<string> {
  if (!book.last) return '';
  if (book.hosts.length < 2) return book.last;
  return (await presence()).get(book.last) === false ? '' : book.last;
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

/** Build-time override (scripts/build-web.mjs, MIXDOG_MOBILE_RELAY_ORIGIN) for
 *  verification builds that pair against a staging relay. */
declare const __MIXDOG_RELAY_ORIGIN__: string | undefined;

/** The relay every install dials unless told otherwise; where a 6-digit code
 *  typed on a fresh phone is redeemed. */
export const DEFAULT_RELAY_ORIGIN =
  typeof __MIXDOG_RELAY_ORIGIN__ === 'string' && __MIXDOG_RELAY_ORIGIN__
    ? __MIXDOG_RELAY_ORIGIN__
    : 'https://192-255-139-161.sslip.io';

/** The six digits in what was typed (`482·917`, `482 917`), or null. */
export function parseCodeInput(text: unknown): string | null {
  const digits = String(text ?? '').replace(/[\s·.-]/gu, '');
  return /^\d{6}$/u.test(digits) ? digits : null;
}

export type RedeemResult =
  | { ok: true; link: { url: string; deviceId: string }; name: string; ticket: string }
  | { ok: false; reason: 'invalid' | 'rate-limited' | 'outdated' | 'network'; retryAfter?: number };

/** Redeems a code at the relay. A right code answers once with the host's
 *  route and a one-time ticket; the host still has to approve the claim. A relay
 *  that does not know the endpoint answers without our JSON: "outdated". */
export async function redeemCode(
  relayOrigin: string,
  code: string,
  doFetch: typeof fetch = fetch
): Promise<RedeemResult> {
  let response: Response;
  try {
    response = await doFetch(`${relayOrigin}/pair-code/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      // A stalled relay is a network failure, not an endless spinner.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  let body: { status?: unknown; deviceId?: unknown; ticket?: unknown; name?: unknown; retryAfter?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    /* not our JSON */
  }
  if (response.status === 200 && typeof body.deviceId === 'string' && typeof body.ticket === 'string') {
    const link = parsePairingLink(`${relayOrigin}/d/${body.deviceId}/`);
    if (link) return { ok: true, link, name: typeof body.name === 'string' ? body.name : '', ticket: body.ticket };
  }
  if (response.status === 429) return { ok: false, reason: 'rate-limited', retryAfter: Number(body.retryAfter) || 60 };
  if (response.status === 404 && body.status === 'invalid-code') return { ok: false, reason: 'invalid' };
  return { ok: false, reason: 'outdated' };
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
