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
import type { RemoteControllerKeyRecord, RemoteControllerKeysOwed } from '../shared/remote-controller-key';
import { MAX_REMOTE_SCREEN_HELPER_KEYS } from '../shared/remote-webrtc';
import { isSecureDesktopControllerKey } from '../shared/secure-desktop-grant';

const CLIENTS_FILE = 'remote-clients.json';

interface Stored {
  clients: DesktopRemoteClientInfo[];
  pendingRevokes: string[];
  /** Each paired phone's secure-desktop controller public key, by client id
   *  (public halves only: nothing here is a secret). */
  controllerKeys: Record<string, string>;
  /** The file was damaged (or unreadable) when it was loaded, so the revocations
   *  it held are unknown. Kept in the file until `clear()` answers it. */
  repairRequired: boolean;
  /** PC access: controller keys of removed pairings, owed a secure-desktop
   *  revoke until the desktop app takes them over (`settleOwedAccess`). */
  owedAccessKeys: string[];
  /** Non-zero while owed access revocations may be missing. */
  owedAccessUnknown: number;
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
   *  queued for the client meanwhile stays (nothing changes). Resolves once
   *  the file holds the outcome, also when another caller confirmed it first. */
  applied(clientId: string, revocation: number): Promise<void>;
  /** The device was approved again (re-paired): a revocation still queued
   *  for it no longer applies. */
  repaired(clientId: string): Promise<void>;
  /** The device identity changed: nothing earlier applies any more, and a
   *  damaged record is answered. Every mapped controller key is owed first. */
  clear(): Promise<void>;
  /** PC access: owes the controller keys of `clientIds` (every mapped one for
   *  'all'), durably — the step every pairing removal takes before a pairing
   *  or its mapping goes (`queueRevoke`, `applied` and `clear` take it in the
   *  same write). Rejects when it could not be written. */
  oweAccess(clientIds: readonly string[] | 'all'): Promise<void>;
  /** The access revocations owed for removed pairings. */
  owedAccess(): RemoteControllerKeysOwed;
  /** The desktop app holds `keys` (and the `unknown` it read) durably now. */
  settleOwedAccess(keys: readonly string[], unknown: number): Promise<void>;
  /** Every delivered controller key, each marked while its device's unpair
   *  is still queued. */
  controllerKeys(): RemoteControllerKeyRecord[];
  /** Keeps the key a paired device delivered. A different earlier key is
   *  replaced and owed a revoke in the same write; a failed write keeps both
   *  as they were. The same key again changes nothing. */
  setControllerKey(clientId: string, publicKey: string): Promise<void>;
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
  // Owed access revocations are checked as strictly; written before they existed: none.
  const owed = parsed.owedAccessKeys ?? [];
  if (!Array.isArray(owed) || !owed.every((key) => isSecureDesktopControllerKey(key))) {
    throw new TypeError('The owed access revocations are not a list of keys.');
  }
  const owedUnknown = parsed.owedAccessUnknown ?? 0;
  if (!Number.isSafeInteger(owedUnknown) || owedUnknown < 0) {
    throw new TypeError('The owed access marker is not a count.');
  }
  const keys =
    parsed.controllerKeys && typeof parsed.controllerKeys === 'object' && !Array.isArray(parsed.controllerKeys)
      ? parsed.controllerKeys
      : {};
  return {
    owedAccessKeys: [...owed],
    owedAccessUnknown: owedUnknown,
    clients: (Array.isArray(parsed.clients) ? parsed.clients : []).flatMap((row) => entry(row) ?? []),
    pendingRevokes: [...parsed.pendingRevokes],
    // Written before keys existed: none. An entry that is not a key is dropped.
    controllerKeys: Object.fromEntries(
      Object.entries(keys).filter(([id, key]) => id && isSecureDesktopControllerKey(key))
    ),
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
  let state: Stored = {
    clients: [],
    pendingRevokes: [],
    controllerKeys: {},
    repairRequired: false,
    owedAccessKeys: [],
    owedAccessUnknown: 0,
  };
  /** Owes the access keys of `clientIds` in memory (the caller persists):
   *  past the pairing cap the revocations become unknown, never dropped. */
  const owe = (clientIds: readonly string[] | 'all'): void => {
    const keys =
      clientIds === 'all'
        ? Object.values(state.controllerKeys)
        : clientIds.flatMap((id) => state.controllerKeys[id] ?? []);
    const owed = [...state.owedAccessKeys];
    for (const key of keys) {
      if (owed.includes(key)) continue;
      if (owed.length >= MAX_REMOTE_SCREEN_HELPER_KEYS) state.owedAccessUnknown += 1;
      else owed.push(key);
    }
    state.owedAccessKeys = owed;
  };
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
    // The paired phones' controller keys went with it: their access revocations are unknown.
    state.owedAccessUnknown = 1;
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
      // cost an owner-only ACL process and two fsyncs per poll. Controller
      // keys are not pruned against it: a list read before a pairing could
      // land after that phone's key. A key goes with its device's confirmed
      // unpair (`applied`) or a reset (`clear`).
      if (JSON.stringify(next) === JSON.stringify(state.clients)) return;
      state.clients = next;
      await persist();
    },
    async queueRevoke(clientId) {
      // Owed in the same step that marks it unpaired: no moment where the
      // device is being removed and its access key is not owed.
      owe([clientId]);
      if (!state.pendingRevokes.includes(clientId)) {
        state.pendingRevokes.push(clientId);
        issue(clientId);
      }
      await persist();
    },
    async applied(clientId, revocation) {
      // Already confirmed by another caller (the relay drain and an explicit
      // unpair can both be answered for one instance), or queued anew: the
      // state holds what it should, but the write that carries it may still be
      // in flight. Resolve only once a write of it has landed.
      if (revocations.get(clientId) !== revocation) return persist();
      revocations.delete(clientId);
      owe([clientId]);
      state.clients = state.clients.filter((client) => client.id !== clientId);
      state.pendingRevokes = state.pendingRevokes.filter((id) => id !== clientId);
      delete state.controllerKeys[clientId];
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
      owe('all');
      state = {
        clients: [],
        pendingRevokes: [],
        controllerKeys: {},
        repairRequired: false,
        owedAccessKeys: state.owedAccessKeys,
        owedAccessUnknown: state.owedAccessUnknown,
      };
      await persist();
    },
    async oweAccess(clientIds) {
      owe(clientIds);
      await persist();
    },
    owedAccess: () => ({ keys: [...state.owedAccessKeys], unknown: state.owedAccessUnknown }),
    async settleOwedAccess(keys, unknown) {
      const left = state.owedAccessKeys.filter((key) => !keys.includes(key));
      const resolved = unknown > 0 && state.owedAccessUnknown === unknown;
      if (left.length === state.owedAccessKeys.length && !resolved) return;
      state.owedAccessKeys = left;
      if (resolved) state.owedAccessUnknown = 0;
      await persist();
    },
    controllerKeys: () =>
      Object.entries(state.controllerKeys).map(([clientId, publicKey]) => ({
        clientId,
        publicKey,
        unpaired: state.pendingRevokes.includes(clientId),
      })),
    async setControllerKey(clientId, publicKey) {
      const previous = state.controllerKeys[clientId];
      if (previous === publicKey) return;
      const wasOwed = previous !== undefined && state.owedAccessKeys.includes(previous);
      // A replaced key may still be enrolled: owed in the same write that
      // stores the new mapping, so the app revokes it before the new one enrolls.
      if (previous !== undefined) owe([clientId]);
      state.controllerKeys = { ...state.controllerKeys, [clientId]: publicKey };
      try {
        await persist();
      } catch (error) {
        // Not written: neither change stands (unless the mapping moved on meanwhile,
        // when the old key stays owed).
        if (state.controllerKeys[clientId] === publicKey) {
          const restored = { ...state.controllerKeys };
          if (previous === undefined) delete restored[clientId];
          else restored[clientId] = previous;
          state.controllerKeys = restored;
          if (previous !== undefined && !wasOwed) {
            state.owedAccessKeys = state.owedAccessKeys.filter((key) => key !== previous);
          }
        }
        throw error;
      }
    },
  };
}
