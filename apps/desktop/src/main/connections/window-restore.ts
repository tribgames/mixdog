// The server windows open at the last quit, reopened at the next launch: their
// host ids live in a small JSON file beside the saved servers. A window the
// user closes is forgotten; quitting keeps the list. A server removed from the
// saved list since is skipped.
import { join } from 'node:path';

import { readJsonState, writeJsonAtomicAsync } from '../../../../../src/runtime/shared/atomic-file.mjs';
import type { DesktopServerRestoreProgress } from '../../shared/contract-connection-link';
import type { DesktopSshHostSettings } from '../../shared/contract-ssh';
import type { ConnectionProgress, SshConnectionSpec } from './contract';

export const SERVER_WINDOWS_FILE = 'server-windows.json';
const MAX_REMEMBERED = 64;

export interface SavedServer {
  id: string;
  name: string;
  target: string;
  /** Its per-host settings, applied to the reopening connection. */
  settings?: DesktopSshHostSettings;
}

export interface ServerWindowRestoreOptions {
  userDataPath: string;
  /** The servers saved on this PC now. */
  savedServers(): Promise<SavedServer[]>;
  open(spec: SshConnectionSpec, onProgress: (progress: ConnectionProgress) => void, server: SavedServer): Promise<void>;
  onProgress(progress: DesktopServerRestoreProgress): void;
}

export interface ServerWindowRestore {
  isEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<boolean>;
  /** A server window opened. */
  remember(id: string): Promise<void>;
  /** The user closed a server window (not a quit). */
  forget(id: string): Promise<void>;
  /** Reopens the remembered windows; resolves when every attempt settled. */
  restore(): Promise<void>;
  /** The reopenings still running or failed, for a window that subscribes
   *  after they were reported. */
  progress(): DesktopServerRestoreProgress[];
}

interface RestoreState {
  enabled: boolean;
  open: string[];
}

function parsed(value: unknown): RestoreState {
  const state = (value ?? {}) as { enabled?: unknown; open?: unknown };
  const open = Array.isArray(state.open)
    ? [...new Set(state.open.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  return { enabled: state.enabled !== false, open: open.slice(0, MAX_REMEMBERED) };
}

export function createServerWindowRestore(options: ServerWindowRestoreOptions): ServerWindowRestore {
  const file = join(options.userDataPath, SERVER_WINDOWS_FILE);
  let loaded: Promise<RestoreState> | null = null;
  let writes: Promise<void> = Promise.resolve();
  // A missing or damaged file (kept aside) starts empty; only an I/O error
  // fails the read, and a failed read is not kept: the next call reads again.
  const state = (): Promise<RestoreState> =>
    (loaded ??= readJsonState(file, { validate: parsed, fallback: parsed(null) }).catch((error: unknown) => {
      loaded = null;
      throw error;
    }));
  const update = async (change: (current: RestoreState) => RestoreState): Promise<RestoreState> => {
    const next = change(await state());
    loaded = Promise.resolve(next);
    const snapshot = { version: 1, ...next };
    writes = writes
      .catch(() => undefined)
      .then(async () => {
        await writeJsonAtomicAsync(file, snapshot, { compact: true });
      });
    await writes;
    return next;
  };

  const latest = new Map<string, DesktopServerRestoreProgress>();
  const publish = (progress: DesktopServerRestoreProgress): void => {
    if (progress.phase === 'ready') latest.delete(progress.id);
    else latest.set(progress.id, progress);
    options.onProgress(progress);
  };

  return {
    progress: () => [...latest.values()],
    isEnabled: async () => (await state()).enabled,
    async setEnabled(enabled) {
      return (await update((current) => ({ ...current, enabled: enabled === true }))).enabled;
    },
    async remember(id) {
      if ((await state()).open.includes(id)) return;
      await update((current) => ({ ...current, open: [...current.open, id].slice(-MAX_REMEMBERED) }));
    },
    async forget(id) {
      if (!(await state()).open.includes(id)) return;
      await update((current) => ({ ...current, open: current.open.filter((entry) => entry !== id) }));
    },
    async restore() {
      const { enabled, open } = await state();
      if (!enabled || open.length === 0) return;
      const saved = new Map((await options.savedServers()).map((server) => [server.id, server]));
      // A server no longer saved is not reopened, and not remembered either.
      const gone = open.filter((id) => !saved.has(id));
      if (gone.length) await update((current) => ({ ...current, open: current.open.filter((id) => saved.has(id)) }));
      await Promise.all(
        open
          .map((id) => saved.get(id))
          .filter((server): server is SavedServer => Boolean(server))
          .map(async (server) => {
            const report = (phase: DesktopServerRestoreProgress['phase'], message?: string): void =>
              publish({ id: server.id, name: server.name, phase, ...(message ? { message } : {}) });
            report('connect');
            try {
              await options.open(
                { id: server.id, name: server.name, target: server.target },
                (progress) => report(progress.phase),
                server
              );
              report('ready');
            } catch (error) {
              report('failed', error instanceof Error ? error.message : String(error));
            }
          })
      );
    },
  };
}
