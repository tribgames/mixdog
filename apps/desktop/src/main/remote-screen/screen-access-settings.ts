/**
 * The whole-PC screen-control setting: a sensitive capability, so it is off by
 * default and enabled only by an explicit choice on the PC. View-only and
 * control are separate grants, each keyed by the paired client's relay
 * credential id — turning the feature on never implies control, and a paired
 * client is granted nothing until it is listed here.
 *
 * Persisted beside the other remote files as an owner-only secret.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeSecretFile } from '../secret-file';

const SETTINGS_FILE = 'remote-screen-settings.json';

export type ScreenGrant = 'none' | 'view' | 'control';

interface StoredSettings {
  /** Master switch. Whole-PC view/control is impossible while this is false. */
  enabled?: boolean;
  /** Per paired client (relay credential id) grant. */
  grants?: Record<string, ScreenGrant>;
}

export interface ScreenAccessSettings {
  enabled: boolean;
  grants: Record<string, ScreenGrant>;
}

export interface ScreenAccessSettingsStore {
  read(): Promise<ScreenAccessSettings>;
  /** The whole-PC switch is on. */
  isEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<ScreenAccessSettings>;
  /** The grant a given paired client has, `none` while the switch is off. */
  grantFor(clientId: string): Promise<ScreenGrant>;
  setGrant(clientId: string, grant: ScreenGrant): Promise<ScreenAccessSettings>;
  /** Drop a client's grant (unpaired or revoked). */
  forget(clientId: string): Promise<ScreenAccessSettings>;
  /** Fires after every saved change, so a live session re-checks its grant
   *  (a revoke or downgrade takes effect at once, not at the next input). */
  onChange(listener: (settings: ScreenAccessSettings) => void): () => void;
}

const GRANTS: ReadonlySet<ScreenGrant> = new Set<ScreenGrant>(['none', 'view', 'control']);
const isGrant = (value: unknown): value is ScreenGrant => typeof value === 'string' && GRANTS.has(value as ScreenGrant);

function normalize(parsed: StoredSettings | null): ScreenAccessSettings {
  const grants: Record<string, ScreenGrant> = {};
  if (parsed?.grants && typeof parsed.grants === 'object') {
    for (const [clientId, grant] of Object.entries(parsed.grants)) {
      if (clientId && isGrant(grant) && grant !== 'none') grants[clientId] = grant;
    }
  }
  return { enabled: parsed?.enabled === true, grants };
}

export function createScreenAccessSettingsStore(userDataPath: string): ScreenAccessSettingsStore {
  const file = join(userDataPath, SETTINGS_FILE);
  const load = async (): Promise<ScreenAccessSettings> => {
    try {
      return normalize(JSON.parse(await readFile(file, 'utf8')) as StoredSettings);
    } catch {
      return normalize(null);
    }
  };
  let writes: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(settings: ScreenAccessSettings) => void>();
  const update = (mutate: (current: ScreenAccessSettings) => ScreenAccessSettings): Promise<ScreenAccessSettings> => {
    const run = writes
      .catch(() => undefined)
      .then(async () => {
        const next = mutate(await load());
        await writeSecretFile(file, JSON.stringify({ enabled: next.enabled, grants: next.grants }));
        for (const listener of listeners) listener(next);
        return next;
      });
    writes = run;
    return run;
  };
  return {
    read: load,
    isEnabled: async () => (await load()).enabled,
    grantFor: async (clientId) => {
      const current = await load();
      return current.enabled ? current.grants[clientId] ?? 'none' : 'none';
    },
    setEnabled: (enabled) => update((current) => ({ ...current, enabled: enabled === true })),
    setGrant: (clientId, grant) =>
      update((current) => {
        const grants = { ...current.grants };
        if (isGrant(grant) && grant !== 'none') grants[clientId] = grant;
        else delete grants[clientId];
        return { ...current, grants };
      }),
    forget: (clientId) =>
      update((current) => {
        if (!(clientId in current.grants)) return current;
        const grants = { ...current.grants };
        delete grants[clientId];
        return { ...current, grants };
      }),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
