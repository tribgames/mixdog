// "Use this PC from other devices": the on/off switch and the PC's own name,
// persisted next to the activation file. Turning access off keeps every pairing;
// it only stops the relay leg. Without a saved switch an install follows its
// activation, so existing installs keep working after the upgrade.
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import type { DesktopRemoteAccessSettings } from '../shared/contract';
import { isRemoteActivated } from './remote-activation';
import { writeSecretFile } from './secret-file';

const SETTINGS_FILE = 'remote-access-settings.json';
export const MAX_REMOTE_PC_NAME_LENGTH = 64;

interface StoredSettings {
  enabled?: boolean;
  name?: string;
}

export interface RemoteAccessSettingsStore {
  read(): Promise<DesktopRemoteAccessSettings>;
  /** True only when the user switched access off; an install that never chose
   *  is not "off", so its first explicit remote action can still activate it. */
  disabled(): Promise<boolean>;
  /** Persists the switch. */
  setEnabled(enabled: boolean): Promise<DesktopRemoteAccessSettings>;
  /** Trims to 64 characters; empty resets to the OS hostname. */
  setName(name: string): Promise<DesktopRemoteAccessSettings>;
}

export function createRemoteAccessSettingsStore(
  userDataPath: string,
  defaultName: () => string = () => hostname().slice(0, MAX_REMOTE_PC_NAME_LENGTH)
): RemoteAccessSettingsStore {
  const file = join(userDataPath, SETTINGS_FILE);
  const load = async (): Promise<StoredSettings> => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as StoredSettings;
      return {
        ...(typeof parsed.enabled === 'boolean' ? { enabled: parsed.enabled } : {}),
        ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      };
    } catch {
      return {};
    }
  };
  const view = async (stored: StoredSettings): Promise<DesktopRemoteAccessSettings> => ({
    enabled: stored.enabled ?? (await isRemoteActivated(userDataPath)),
    name: stored.name || defaultName(),
    defaultName: defaultName(),
  });
  let writes: Promise<unknown> = Promise.resolve();
  const update = (patch: StoredSettings): Promise<DesktopRemoteAccessSettings> => {
    const run = writes
      .catch(() => undefined)
      .then(async () => {
        const next = { ...(await load()), ...patch };
        if (!next.name) delete next.name;
        await writeSecretFile(file, JSON.stringify(next));
        return view(next);
      });
    writes = run;
    return run;
  };
  return {
    read: async () => view(await load()),
    disabled: async () => (await load()).enabled === false,
    setEnabled: (enabled) => update({ enabled: enabled === true }),
    setName: (name) =>
      update({
        name: String(name ?? '')
          .trim()
          .slice(0, MAX_REMOTE_PC_NAME_LENGTH),
      }),
  };
}
