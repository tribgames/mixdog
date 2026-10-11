// The paired-device list as last reported by the relay, kept in userData so the
// off state can still show it after a restart, plus revocations asked for while
// the relay link was closed. Holds display fields only: no tokens or secrets.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DesktopRemoteClientInfo } from '../shared/contract';
import { writeSecretFile } from './secret-file';

const CLIENTS_FILE = 'remote-clients.json';

interface Stored {
  clients: DesktopRemoteClientInfo[];
  pendingRevokes: string[];
}

export interface RemoteClientCache {
  /** The last known list; every entry offline. Devices awaiting revocation stay
   *  listed, flagged `pendingRemoval`. */
  list(): DesktopRemoteClientInfo[];
  /** Revocations still to be applied at the relay. */
  pending(): string[];
  /** Records what the relay reported. */
  remember(clients: DesktopRemoteClientInfo[]): Promise<void>;
  /** Queues the revocation for the next relay leg; the client stays listed as pending. */
  queueRevoke(clientId: string): Promise<void>;
  /** The relay confirmed the revocation. */
  applied(clientId: string): Promise<void>;
  /** The device identity changed: nothing earlier applies any more. */
  clear(): Promise<void>;
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const time = (value: unknown): number => (Number.isFinite(value) ? Number(value) : 0);

const entry = (value: unknown): DesktopRemoteClientInfo | null => {
  const row = value as Partial<DesktopRemoteClientInfo> | null;
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  return {
    id: row.id.slice(0, 80),
    name: text(row.name, 80),
    platform: text(row.platform, 80),
    browser: text(row.browser, 80),
    createdAt: time(row.createdAt),
    lastSeenAt: time(row.lastSeenAt),
    online: false,
  };
};

export async function loadRemoteClientCache(userDataPath: string): Promise<RemoteClientCache> {
  const file = join(userDataPath, CLIENTS_FILE);
  let state: Stored = { clients: [], pendingRevokes: [] };
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<Stored>;
    state = {
      clients: (Array.isArray(parsed.clients) ? parsed.clients : []).flatMap((row) => entry(row) ?? []),
      pendingRevokes: (Array.isArray(parsed.pendingRevokes) ? parsed.pendingRevokes : []).filter(
        (id): id is string => typeof id === 'string'
      ),
    };
  } catch {
    /* first run or unreadable: start empty */
  }
  const persist = (): Promise<void> => writeSecretFile(file, JSON.stringify(state));
  return {
    list: () =>
      state.clients.map((client) =>
        state.pendingRevokes.includes(client.id) ? { ...client, pendingRemoval: true } : { ...client }
      ),
    pending: () => [...state.pendingRevokes],
    async remember(clients) {
      state.clients = clients.flatMap((row) => entry(row) ?? []);
      await persist();
    },
    async queueRevoke(clientId) {
      if (!state.pendingRevokes.includes(clientId)) state.pendingRevokes.push(clientId);
      await persist();
    },
    async applied(clientId) {
      state.clients = state.clients.filter((client) => client.id !== clientId);
      state.pendingRevokes = state.pendingRevokes.filter((id) => id !== clientId);
      await persist();
    },
    async clear() {
      state = { clients: [], pendingRevokes: [] };
      await persist();
    },
  };
}
