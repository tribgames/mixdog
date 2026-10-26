// The paired-device list as last reported by the relay, kept in userData so the
// off state can still show it after a restart, plus revocations asked for while
// the relay link was closed. Holds display fields only: no tokens or secrets.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  parseJsonText,
  quarantinePath,
  writeFileAtomicAsync,
  writeJsonAtomicAsync,
} from '../../../../src/runtime/shared/atomic-file.mjs';
import type { DesktopRemoteClientInfo } from '../shared/contract';

const CLIENTS_FILE = 'remote-clients.json';

interface Stored {
  clients: DesktopRemoteClientInfo[];
  pendingRevokes: string[];
  /** The file was damaged (or unreadable) when it was loaded, so the revocations
   *  it held are unknown. Kept in the file until `clear()` answers it. */
  repairRequired: boolean;
}

export interface RemoteClientCache {
  /** The last known list; every entry offline. Devices awaiting revocation stay
   *  listed, flagged `pendingRemoval`. */
  list(): DesktopRemoteClientInfo[];
  /** Revocations still to be applied at the relay. */
  pending(): string[];
  /** The instance of the client's queued revocation: a new one each time it
   *  is queued anew (after a confirmation or a re-pair withdrew the last);
   *  null when none is queued. Kept for this run only: no acknowledgement
   *  outlives a restart. */
  revocation(clientId: string): number | null;
  /** The stored revocations were lost to damage: no paired device can be
   *  trusted as un-revoked until the pairing is reset and `clear()` is called. */
  repairRequired(): boolean;
  /** Records what the relay reported. */
  remember(clients: DesktopRemoteClientInfo[]): Promise<void>;
  /** Queues the revocation for the next relay leg; the client stays listed as pending. */
  queueRevoke(clientId: string): Promise<void>;
  /** The relay confirmed the revocation sent for `revocation`. A newer one
   *  queued for the client meanwhile stays (nothing changes). */
  applied(clientId: string, revocation: number): Promise<void>;
  /** The device was approved again (re-paired): a revocation still queued
   *  for it no longer applies. */
  repaired(clientId: string): Promise<void>;
  /** The device identity changed: nothing earlier applies any more, and a
   *  damaged record is answered. */
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

function storedOf(value: unknown): Stored {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('The client cache is not an object.');
  }
  const parsed = value as Partial<Stored>;
  // The revocation record is checked strictly: a wrong shape is damage, never an empty list.
  if (!Array.isArray(parsed.pendingRevokes) || !parsed.pendingRevokes.every((id) => typeof id === 'string')) {
    throw new TypeError('The pending revocations are not a list of ids.');
  }
  if (parsed.repairRequired !== undefined && typeof parsed.repairRequired !== 'boolean') {
    throw new TypeError('The repair flag is not a boolean.');
  }
  return {
    clients: (Array.isArray(parsed.clients) ? parsed.clients : []).flatMap((row) => entry(row) ?? []),
    pendingRevokes: [...parsed.pendingRevokes],
    repairRequired: parsed.repairRequired === true,
  };
}

/** What the file holds: its record, nothing (`stored: null`, it was never
 *  written), or damage — which is not the same as nothing. `damaged` carries
 *  the bytes that could be read, null when none could. */
async function readStored(file: string): Promise<{ stored: Stored | null } | { damaged: Buffer | null }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stored: null };
    return { damaged: null };
  }
  try {
    return { stored: storedOf(parseJsonText(bytes.toString('utf8'))) };
  } catch {
    return { damaged: bytes };
  }
}

export async function loadRemoteClientCache(userDataPath: string): Promise<RemoteClientCache> {
  const file = join(userDataPath, CLIENTS_FILE);
  let state: Stored = { clients: [], pendingRevokes: [], repairRequired: false };
  /** Queued revocation → its instance (this run only). */
  const revocations = new Map<string, number>();
  let lastRevocation = 0;
  const issue = (clientId: string): void => {
    lastRevocation += 1;
    revocations.set(clientId, lastRevocation);
  };
  let writes: Promise<void> = Promise.resolve();
  // One write at a time, in order, each of the state as it stands when its turn comes.
  const persist = (): Promise<void> => {
    writes = writes
      .catch(() => undefined)
      .then(async () => {
        await writeJsonAtomicAsync(file, state, { secret: true, fsyncDir: true, compact: true });
      });
    return writes;
  };
  const read = await readStored(file);
  if ('stored' in read) {
    if (read.stored) state = read.stored;
  } else {
    // The pending revocations are unknown, and no older copy can say they were
    // all in it (it may predate the latest one), so none is consulted: every
    // paired device is revoked by the pairing reset this flag asks for. The
    // damaged bytes are copied aside and the flag written over them, so a crash
    // before either finishes finds the damage again instead of an empty file.
    state.repairRequired = true;
    if (read.damaged) {
      await writeFileAtomicAsync(quarantinePath(file), read.damaged, { secret: true }).catch(() => undefined);
    }
    await persist().catch(() => undefined);
  }
  for (const clientId of state.pendingRevokes) issue(clientId);
  return {
    list: () =>
      state.clients.map((client) =>
        state.pendingRevokes.includes(client.id) ? { ...client, pendingRemoval: true } : { ...client }
      ),
    pending: () => [...state.pendingRevokes],
    revocation: (clientId) => revocations.get(clientId) ?? null,
    repairRequired: () => state.repairRequired,
    async remember(clients) {
      const next = clients.flatMap((row) => entry(row) ?? []);
      // Each remote-access read reports the list; rewriting an unchanged one
      // cost an owner-only ACL process and two fsyncs per poll.
      if (JSON.stringify(next) === JSON.stringify(state.clients)) return;
      state.clients = next;
      await persist();
    },
    async queueRevoke(clientId) {
      if (!state.pendingRevokes.includes(clientId)) {
        state.pendingRevokes.push(clientId);
        issue(clientId);
      }
      await persist();
    },
    async applied(clientId, revocation) {
      if (revocations.get(clientId) !== revocation) return;
      revocations.delete(clientId);
      state.clients = state.clients.filter((client) => client.id !== clientId);
      state.pendingRevokes = state.pendingRevokes.filter((id) => id !== clientId);
      await persist();
    },
    async repaired(clientId) {
      if (!state.pendingRevokes.includes(clientId)) return;
      revocations.delete(clientId);
      state.pendingRevokes = state.pendingRevokes.filter((id) => id !== clientId);
      await persist();
    },
    async clear() {
      revocations.clear();
      state = { clients: [], pendingRevokes: [], repairRequired: false };
      await persist();
    },
  };
}
