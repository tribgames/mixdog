// The port forwards of each saved server, kept on this PC beside the saved
// servers and started again whenever that server's connection comes back.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  const state = (): Promise<Record<string, SavedPortForward[]>> =>
    (loaded ??= readFile(file, 'utf8').then(
      (text) => parsed(JSON.parse(text)),
      (): Record<string, SavedPortForward[]> => ({})
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
      const snapshot = JSON.stringify({ version: 1, hosts: next });
      writes = writes
        .catch(() => undefined)
        .then(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(`${file}.tmp`, snapshot, 'utf8');
          await rename(`${file}.tmp`, file);
        });
      await writes;
    },
  };
}
