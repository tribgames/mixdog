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

export function remoteHostId(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16);
}

/** Each host gets its own persistent storage container, so its pairing
 *  credential and E2EE keys never mix with another host or the local app. */
export function remoteHostPartition(id: string): string {
  return `persist:remote-host-${id}`;
}

export function defaultRemoteHostName(link: ParsedRemoteHostLink): string {
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
  name: string;
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
}

function storedHosts(value: unknown): StoredHost[] {
  const rows = (value as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(rows)) return [];
  const hosts: StoredHost[] = [];
  for (const row of rows as Array<Partial<StoredHost> | null>) {
    const link = parseRemoteHostLink(row?.url);
    if (!link || typeof row?.name !== 'string') continue;
    hosts.push({
      id: remoteHostId(link.url),
      name: row.name.slice(0, MAX_NAME_LENGTH),
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
    list: () => hosts.map((host) => ({ ...host })),
    get: (id) => hosts.find((host) => host.id === id),
    async save(link, name) {
      const id = remoteHostId(link.url);
      const label = name.trim().slice(0, MAX_NAME_LENGTH) || defaultRemoteHostName(link);
      const existing = hosts.find((host) => host.id === id);
      if (existing) {
        if (name.trim()) existing.name = label;
        await persist();
        return { ...existing };
      }
      if (hosts.length >= MAX_SAVED_HOSTS) throw new Error('Too many saved computers. Forget one first.');
      const created: StoredHost = { id, name: label, url: link.url, addedAt: Date.now(), lastConnectedAt: null };
      hosts = [...hosts, created];
      await persist();
      return { ...created };
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
