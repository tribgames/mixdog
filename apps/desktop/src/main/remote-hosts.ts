// "Connect to another PC": the hosts this machine has saved, the pairing link
// that names one, and the rules for its dedicated remote window. Pure and
// Electron-free so every rule is testable; remote-host-windows.ts owns the
// windows themselves.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DesktopRemoteHost } from '../shared/contract';

const HOSTS_FILE = 'remote-hosts.json';
const MAX_SAVED_HOSTS = 32;
const MAX_NAME_LENGTH = 80;
// The relay route `relayClientUrl` builds: /d/<device id>/ (uuid or long hex).
const DEVICE_ROUTE = /^\/d\/((?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|[0-9a-f]{32,64})\/?$/iu;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ParsedRemoteHostLink {
  /** Canonical link: origin + device route, no query or fragment. */
  url: string;
  deviceId: string;
}

/** The host a pasted pairing link names, or null when it is not one. The link
 *  carries a route, never a credential. Plain http is only for a loopback relay. */
export function parseRemoteHostLink(text: unknown): ParsedRemoteHostLink | null {
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

/** The six digits in what a person typed (`482·917`, `482 917`), or null. */
export function parsePairCodeInput(text: unknown): string | null {
  const digits = String(text ?? '').replace(/[\s·.-]/gu, '');
  return /^\d{6}$/u.test(digits) ? digits : null;
}

/** `wss://host` → `https://host` (loopback `ws://` → `http://`): the relay's HTTP origin. */
export function relayHttpOrigin(relayUrl: string): string {
  const url = new URL(relayUrl);
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
}

export interface RedeemedPairCode {
  deviceId: string;
  /** The host's own name for itself ('' when it did not say). */
  name: string;
  /** One-time proof the relay redeemed a code; rides the first claim. */
  ticket: string;
}

type Fetch = typeof fetch;

/** Redeems a 6-digit code at the relay. The relay answers a right code once
 *  and rate-limits wrong ones, so the messages here are all a person needs. */
export async function redeemPairCode(
  relayOrigin: string,
  code: string,
  doFetch: Fetch = fetch,
  // Localizes the messages; the main-process caller passes `nativeT`.
  translate: (key: string) => string = (key) => key
): Promise<RedeemedPairCode> {
  const response = await doFetch(`${relayOrigin}/pair-code/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(10_000),
  });
  let body: { status?: unknown; deviceId?: unknown; name?: unknown; ticket?: unknown; retryAfter?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    /* an older relay answers without JSON */
  }
  if (response.status === 200 && typeof body.deviceId === 'string' && typeof body.ticket === 'string') {
    return {
      deviceId: body.deviceId,
      ticket: body.ticket,
      name: typeof body.name === 'string' ? body.name.slice(0, MAX_NAME_LENGTH) : '',
    };
  }
  if (response.status === 429) {
    throw new Error(
      translate('Too many attempts. Try again in {{seconds}} seconds.').replace(
        '{{seconds}}',
        String(Number(body.retryAfter) || 60)
      )
    );
  }
  if (response.status === 404 && body.status === 'invalid-code') {
    throw new Error(translate('The code is wrong or has expired.'));
  }
  throw new Error(translate('Codes are not available on this connection server yet. Use the QR code.'));
}

/** Which of these hosts are connected to their relay right now. Hosts on a
 *  relay that cannot answer are simply absent from the result. */
export async function fetchHostPresence(
  hosts: Array<{ id: string; url: string }>,
  doFetch: Fetch = fetch
): Promise<Map<string, boolean>> {
  const byOrigin = new Map<string, Array<{ id: string; deviceId: string }>>();
  for (const host of hosts) {
    const link = parseRemoteHostLink(host.url);
    if (!link) continue;
    const origin = new URL(link.url).origin;
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), { id: host.id, deviceId: link.deviceId }]);
  }
  const online = new Map<string, boolean>();
  await Promise.all(
    [...byOrigin].map(async ([origin, group]) => {
      try {
        const response = await doFetch(`${origin}/pair-code/presence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: group.map((host) => host.deviceId).slice(0, 16) }),
          signal: AbortSignal.timeout(4_000),
        });
        if (!response.ok) return;
        const body = (await response.json()) as { online?: Record<string, unknown> };
        for (const host of group) online.set(host.id, body.online?.[host.deviceId] === true);
      } catch {
        /* unreachable relay: state unknown */
      }
    })
  );
  return online;
}

export function remoteHostId(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16);
}

/** Each host gets its own persistent storage container, so its pairing
 *  credential and E2EE keys never mix with another host or the local app. */
export function remoteHostPartition(id: string): string {
  return `persist:remote-host-${id}`;
}

function defaultRemoteHostName(link: ParsedRemoteHostLink): string {
  return `${new URL(link.url).host} · ${link.deviceId.slice(0, 8)}`;
}

/** The window title; the in-app indicator reads the same name. */
export function remoteWindowTitle(name: string): string {
  return `Connected to ${name} — Mixdog`;
}

/** The page must see an ordinary browser (no Electron token), because that is
 *  what makes it install the relay shim instead of expecting a local bridge. */
export function remoteWindowUserAgent(defaultUserAgent: string, appName: string): string {
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const stripped = defaultUserAgent
    .replace(/\sElectron\/\S+/gu, '')
    .replace(new RegExp(`\\s${escaped}\\/\\S+`, 'gu'), '');
  return `${stripped} MixdogDesktop/1`;
}

/** Same relay origin: stays in the remote window. Anything else is a link the
 *  user's default browser should handle. */
export function isRemoteHostNavigation(hostUrl: string, target: string): boolean {
  try {
    return new URL(target).origin === new URL(hostUrl).origin;
  } catch {
    return false;
  }
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** The target of a link click that may be handed to the OS, or null. */
export function externalLinkTarget(target: string): string | null {
  try {
    const url = new URL(target);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

interface StoredHost {
  id: string;
  /** What the host announced (or the default label). The user's alias lives
   *  in `alias` and is what `list()`/`get()` report as `name`. */
  name: string;
  alias?: string;
  url: string;
  addedAt: number;
  lastConnectedAt: number | null;
}

export interface RemoteHostStore {
  list(): StoredHost[];
  get(id: string): StoredHost | undefined;
  /** Adds the host, or updates the name of one already saved. */
  save(link: ParsedRemoteHostLink, name: string): Promise<StoredHost>;
  touch(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Local alias for a saved PC; empty resets to the PC's announced name. */
  rename(id: string, alias: string): Promise<void>;
}

const viewHost = (host: StoredHost): StoredHost => {
  const { alias, ...rest } = host;
  return { ...rest, name: alias || host.name };
};

function storedHosts(value: unknown): StoredHost[] {
  const rows = (value as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(rows)) return [];
  const hosts: StoredHost[] = [];
  for (const row of rows as Array<Partial<StoredHost> | null>) {
    const link = parseRemoteHostLink(row?.url);
    if (!link || typeof row?.name !== 'string') continue;
    const alias = typeof row.alias === 'string' ? row.alias.trim().slice(0, MAX_NAME_LENGTH) : '';
    hosts.push({
      id: remoteHostId(link.url),
      name: row.name.slice(0, MAX_NAME_LENGTH),
      ...(alias ? { alias } : {}),
      url: link.url,
      addedAt: Number.isFinite(row.addedAt) ? Number(row.addedAt) : Date.now(),
      lastConnectedAt: Number.isFinite(row.lastConnectedAt) ? Number(row.lastConnectedAt) : null,
    });
  }
  return hosts;
}

export async function loadRemoteHostStore(userDataPath: string): Promise<RemoteHostStore> {
  const file = join(userDataPath, HOSTS_FILE);
  let hosts: StoredHost[] = [];
  try {
    hosts = storedHosts(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    /* first run, or an unreadable list: start empty */
  }
  let writes: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const snapshot = JSON.stringify({ version: 1, hosts });
    writes = writes
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, snapshot, 'utf8');
        await rename(`${file}.tmp`, file);
      });
    return writes;
  };
  return {
    list: () => hosts.map(viewHost),
    get: (id) => {
      const host = hosts.find((entry) => entry.id === id);
      return host && viewHost(host);
    },
    async rename(id, alias) {
      const host = hosts.find((entry) => entry.id === id);
      if (!host) return;
      const label = String(alias ?? '')
        .trim()
        .slice(0, MAX_NAME_LENGTH);
      if (label) host.alias = label;
      else delete host.alias;
      await persist();
    },
    async save(link, name) {
      const id = remoteHostId(link.url);
      const label = name.trim().slice(0, MAX_NAME_LENGTH) || defaultRemoteHostName(link);
      const existing = hosts.find((host) => host.id === id);
      if (existing) {
        if (name.trim()) existing.name = label;
        await persist();
        return viewHost(existing);
      }
      if (hosts.length >= MAX_SAVED_HOSTS) throw new Error('Too many saved computers. Forget one first.');
      const created: StoredHost = { id, name: label, url: link.url, addedAt: Date.now(), lastConnectedAt: null };
      hosts = [...hosts, created];
      await persist();
      return viewHost(created);
    },
    async touch(id) {
      const host = hosts.find((entry) => entry.id === id);
      if (!host) return;
      host.lastConnectedAt = Date.now();
      await persist();
    },
    async remove(id) {
      hosts = hosts.filter((host) => host.id !== id);
      await persist();
    },
  };
}

export function toDesktopRemoteHost(host: StoredHost, open: boolean): DesktopRemoteHost {
  return { ...host, open };
}
