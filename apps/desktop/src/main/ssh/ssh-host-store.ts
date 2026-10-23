// The SSH servers this machine has connected to: a small JSON list in the app
// data folder. Only the entry is stored here — never a key, password or token.
import { join } from 'node:path';

import {
  readJsonState,
  readJsonStateSync,
  writeJsonAtomicAsync,
} from '../../../../../src/runtime/shared/atomic-file.mjs';
import type { SshHostSettings } from './ssh-context';
import { parseSshTarget, sshTargetKey } from './ssh-command';

const HOSTS_FILE = 'ssh-hosts.json';
const MAX_SAVED_HOSTS = 64;
const MAX_NAME_LENGTH = 80;

export interface SshHostRecord {
  id: string;
  name: string;
  /** `alias`, `host`, `user@host` or `user@host:port`, as parseSshTarget accepts it. */
  target: string;
  lastConnectedAt: number | null;
  settings?: SshHostSettings;
}

export interface SshHostStore {
  list(): SshHostRecord[];
  get(id: string): SshHostRecord | undefined;
  findByTarget(target: string): SshHostRecord | undefined;
  /** Adds the server, or replaces the one with the same id. */
  save(record: SshHostRecord): Promise<SshHostRecord>;
  rename(id: string, name: string): Promise<void>;
  updateSettings(id: string, settings: SshHostSettings): Promise<void>;
  /** The model providers this server may use; null: every provider enabled on this PC. An unsaved id gets none. */
  allowedProvidersForHost(id: string): string[] | null;
  remove(id: string): Promise<void>;
}

const cleanName = (name: unknown): string =>
  String(name ?? '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);

const MAX_PATH_LENGTH = 512;
/** How long the server keeps its work after the connection drops (daemon client grace and the reconnect backoff cap). */
export const DEFAULT_GRACE_MINUTES = 30;
export const MIN_GRACE_MINUTES = 1;
export const MAX_GRACE_MINUTES = 10_080;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_ALLOWED_PROVIDERS = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** The per-server settings as saved: trimmed, empty fields dropped. Throws when a value cannot be used. */
export function parseHostSettings(raw: unknown): SshHostSettings {
  const input = (raw ?? {}) as Record<string, unknown>;
  const settings: SshHostSettings = {};
  const text = (value: unknown, what: string): string => {
    const trimmed = String(value ?? '').trim();
    if (trimmed.length > MAX_PATH_LENGTH || CONTROL_CHARACTERS.test(trimmed)) throw new Error(`${what} is not valid.`);
    return trimmed;
  };
  const remoteCwd = text(input.remoteCwd, 'The server folder');
  if (remoteCwd) {
    if (remoteCwd !== '~' && !remoteCwd.startsWith('~/') && !remoteCwd.startsWith('/'))
      throw new Error('The server folder must be an absolute server path or start with ~.');
    settings.remoteCwd = remoteCwd;
  }
  const identityFile = text(input.identityFile, 'The key file');
  if (identityFile) {
    if (identityFile.startsWith('-')) throw new Error('The key file must not start with "-".');
    settings.identityFile = identityFile;
  }
  if (typeof input.autoReconnect === 'boolean') settings.autoReconnect = input.autoReconnect;
  if (input.graceMinutes !== undefined && input.graceMinutes !== null && input.graceMinutes !== '') {
    const minutes = Number(input.graceMinutes);
    if (!Number.isInteger(minutes) || minutes < MIN_GRACE_MINUTES || minutes > MAX_GRACE_MINUTES) {
      throw new Error(
        `The time to keep the server’s work must be a whole number of minutes from ${MIN_GRACE_MINUTES} to ${MAX_GRACE_MINUTES}.`
      );
    }
    settings.graceMinutes = minutes;
  }
  if (Array.isArray(input.allowedProviders)) {
    const ids = new Set<string>();
    for (const entry of input.allowedProviders) {
      const id = typeof entry === 'string' ? entry.trim() : '';
      if (!id || id.length > MAX_PROVIDER_ID_LENGTH || CONTROL_CHARACTERS.test(id))
        throw new Error('A provider id is not valid.');
      ids.add(id);
    }
    if (ids.size > MAX_ALLOWED_PROVIDERS) throw new Error('Too many providers.');
    settings.allowedProviders = [...ids];
  }
  // Only the opt-in is stored: absent is this PC's logins.
  if (input.modelLogin !== undefined && input.modelLogin !== null && input.modelLogin !== 'pc') {
    if (input.modelLogin !== 'server') throw new Error('The model login is not valid.');
    settings.modelLogin = 'server';
  }
  return settings;
}

const copyHost = (host: SshHostRecord): SshHostRecord => ({
  ...host,
  ...(host.settings && {
    settings: {
      ...host.settings,
      ...(host.settings.allowedProviders && { allowedProviders: [...host.settings.allowedProviders] }),
    },
  }),
});

// One store per user-data folder, shared by the IPC handlers and the provider lookup.
const stores = new Map<string, Promise<SshHostStore>>();
let configuredPath: string | null = null;

/** Names the user-data folder the saved servers live in; the provider lookup reads from it. */
export function configureSshHostStore(userDataPath: string): void {
  configuredPath = userDataPath;
}

/** The store of a user-data folder, loaded once; also the one allowedProvidersForHost reads once it is loaded. */
export function sharedSshHostStore(userDataPath: string): Promise<SshHostStore> {
  configuredPath = userDataPath;
  let store = stores.get(userDataPath);
  if (!store) {
    store = loadSshHostStore(userDataPath).then((loaded) => {
      loadedStores.set(userDataPath, loaded);
      return loaded;
    });
    stores.set(userDataPath, store);
  }
  return store;
}
const loadedStores = new Map<string, SshHostStore>();

/**
 * The model providers the saved server hostId may use through this PC: null for
 * every provider enabled here, a list for those the user allowed, an empty list
 * for a server that is not saved (or whose list cannot be read). Synchronous, and
 * never dependent on the IPC handlers having loaded the store: before it is
 * loaded, the saved list is read from disk, so a saved server's setting is
 * always honored.
 */
export function allowedProvidersForHost(hostId: string): string[] | null {
  const host = savedHostSync(hostId);
  if (!host) return [];
  return host.settings?.allowedProviders ? [...host.settings.allowedProviders] : null;
}
/** The saved entry, from the loaded store or else from disk. */
function savedHostSync(hostId: string): SshHostRecord | undefined {
  if (!configuredPath) return undefined;
  const loaded = loadedStores.get(configuredPath);
  if (loaded) return loaded.get(hostId);
  try {
    return storedHosts(readJsonStateSync(join(configuredPath, HOSTS_FILE), { validate: hostsDocument })).find(
      (entry) => entry.id === hostId
    );
  } catch {
    return undefined;
  }
}

/** A saved list is an object holding a `hosts` array; anything else is damage. */
function hostsDocument(value: unknown): unknown {
  if (!Array.isArray((value as { hosts?: unknown } | null)?.hosts)) throw new TypeError('Missing hosts list.');
  return value;
}
const keyOf = (target: string): string => sshTargetKey(parseSshTarget(target));

function storedHosts(value: unknown): SshHostRecord[] {
  const rows = (value as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(rows)) return [];
  const hosts: SshHostRecord[] = [];
  for (const row of rows as Array<Partial<SshHostRecord> | null>) {
    if (typeof row?.id !== 'string' || !row.id || typeof row.target !== 'string') continue;
    let target: string;
    try {
      target = parseSshTarget(row.target).display;
    } catch {
      continue;
    }
    const name = cleanName(row.name);
    if (!name || hosts.some((host) => host.id === row.id || keyOf(host.target) === keyOf(target))) continue;
    let settings: SshHostSettings | undefined;
    try {
      settings = parseHostSettings(row.settings);
    } catch {
      settings = undefined;
    }
    hosts.push({
      id: row.id,
      name,
      target,
      lastConnectedAt: Number.isFinite(row.lastConnectedAt) ? Number(row.lastConnectedAt) : null,
      ...(settings && Object.keys(settings).length ? { settings } : {}),
    });
  }
  return hosts.slice(0, MAX_SAVED_HOSTS);
}

export async function loadSshHostStore(userDataPath: string): Promise<SshHostStore> {
  const file = join(userDataPath, HOSTS_FILE);
  let hosts: SshHostRecord[] = [];
  try {
    // A damaged list is kept aside as .corrupt-<ts> and the last good copy restored.
    hosts = storedHosts(await readJsonState(file, { validate: hostsDocument }));
  } catch (error) {
    // The file cannot be read at all (permissions…): work in memory; a write
    // that cannot read the file it replaces fails instead of wiping it.
    console.warn(`[ssh-hosts] ${file} could not be read: ${(error as Error).message}`);
  }
  let writes: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const snapshot = structuredClone({ version: 1, hosts });
    writes = writes
      .catch(() => undefined)
      .then(async () => {
        await writeJsonAtomicAsync(file, snapshot, { compact: true, backup: true });
      });
    return writes;
  };
  const store: SshHostStore = {
    list: () => hosts.map(copyHost),
    allowedProvidersForHost: (id) => {
      const host = hosts.find((entry) => entry.id === id);
      if (!host) return [];
      return host.settings?.allowedProviders ? [...host.settings.allowedProviders] : null;
    },
    get: (id) => {
      const host = hosts.find((entry) => entry.id === id);
      return host && copyHost(host);
    },
    findByTarget: (target) => {
      const key = keyOf(target);
      const host = hosts.find((entry) => keyOf(entry.target) === key);
      return host && copyHost(host);
    },
    async save(record) {
      const target = parseSshTarget(record.target).display;
      const key = keyOf(target);
      const previous = hosts.find((entry) => entry.id === record.id);
      const settings = record.settings ?? previous?.settings;
      const saved: SshHostRecord = {
        id: record.id,
        name: cleanName(record.name) || record.target,
        target,
        lastConnectedAt: record.lastConnectedAt,
        ...(settings && Object.keys(settings).length ? { settings } : {}),
      };
      // The same server under another spelling of its host name is the same entry.
      hosts = [saved, ...hosts.filter((entry) => entry.id !== saved.id && keyOf(entry.target) !== key)].slice(
        0,
        MAX_SAVED_HOSTS
      );
      await persist();
      return copyHost(saved);
    },
    async rename(id, name) {
      const host = hosts.find((entry) => entry.id === id);
      const label = cleanName(name);
      if (!host || !label) return;
      host.name = label;
      await persist();
    },
    async updateSettings(id, settings) {
      const host = hosts.find((entry) => entry.id === id);
      if (!host) return;
      const next = parseHostSettings(settings);
      if (Object.keys(next).length) host.settings = next;
      else delete host.settings;
      await persist();
    },
    async remove(id) {
      const next = hosts.filter((entry) => entry.id !== id);
      if (next.length === hosts.length) return;
      hosts = next;
      await persist();
    },
  };
  return store;
}
