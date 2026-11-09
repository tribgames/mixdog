// The port forwards of each saved server, kept on this PC beside the saved
// servers and started again whenever that server's connection comes back.
import { join } from 'node:path';

import { readJsonState, writeJsonAtomicAsync } from '../../../../../src/runtime/shared/atomic-file.mjs';

export const PORT_FORWARDS_FILE = 'port-forwards.json';
const MAX_FORWARDS_PER_HOST = 64;

export interface SavedPortForward {
  remotePort: number;
  /** The local port last used; taken again when it is free. */
  localPort: number;
}

export interface PortForwardStore {
  load(hostId: string): Promise<SavedPortForward[]>;
  save(hostId: string, forwards: SavedPortForward[]): Promise<void>;
}

const validPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535;

function parsed(value: unknown): Record<string, SavedPortForward[]> {
  const hosts = (value as { hosts?: unknown } | null)?.hosts;
  if (!hosts || typeof hosts !== 'object') return {};
  const result: Record<string, SavedPortForward[]> = {};
  for (const [id, list] of Object.entries(hosts as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const forwards = list
      .filter((entry): entry is SavedPortForward => validPort(entry?.remotePort) && validPort(entry?.localPort))
      .map(({ remotePort, localPort }) => ({ remotePort, localPort }))
      .slice(0, MAX_FORWARDS_PER_HOST);
    if (forwards.length) result[id] = forwards;
  }
  return result;
}

export function createPortForwardStore(userDataPath: string): PortForwardStore {
  const file = join(userDataPath, PORT_FORWARDS_FILE);
  let loaded: Promise<Record<string, SavedPortForward[]>> | null = null;
  let writes: Promise<void> = Promise.resolve();
  // A missing or damaged file (kept aside, the last good copy restored) starts
  // empty; only an I/O error fails the read, and a failed read is not kept:
  // the next call reads again.
  const state = (): Promise<Record<string, SavedPortForward[]>> =>
    (loaded ??= readJsonState(file, { validate: parsed, fallback: {} as Record<string, SavedPortForward[]> }).catch(
      (error: unknown) => {
        loaded = null;
        throw error;
      }
    ));
  return {
    async load(hostId) {
      return [...((await state())[hostId] ?? [])];
    },
    async save(hostId, forwards) {
      const current = await state();
      const next = { ...current };
      const kept = forwards.filter((entry) => validPort(entry.remotePort) && validPort(entry.localPort));
      if (kept.length) next[hostId] = kept.slice(0, MAX_FORWARDS_PER_HOST);
      else delete next[hostId];
      loaded = Promise.resolve(next);
      const snapshot = { version: 1, hosts: next };
      writes = writes
        .catch(() => undefined)
        .then(async () => {
          await writeJsonAtomicAsync(file, snapshot, { backup: true, compact: true });
        });
      await writes;
    },
  };
}
