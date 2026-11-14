// What a saved server's settings say about the model calls its window runs on this PC's sign-ins: whether the server runs
// models with its own logins, and which providers it may use through this PC. The saved servers are this PC's core's
// (`connections/ssh/list`); the answers are read from the list as it was when a window opened or the lists last changed.
import type { SshHost } from '../../../../../packages/protocol/src/index.ts';
import type { CoreCaller } from './server-window-record';

export interface ServerModelAccess {
  /** The server's daemon runs models with the logins stored on the server. */
  serverLogin: boolean;
  /** The providers the server may use through this PC; null: every provider enabled here. */
  allowedProviders: readonly string[] | null;
}

export interface ServerHostSettings {
  /** Reads the saved servers from this PC's core. A list that cannot be read keeps the last one read. */
  refresh(): Promise<void>;
  modelAccess(id: string): ServerModelAccess;
}

const NO_LIMIT: ServerModelAccess = { serverLogin: false, allowedProviders: null };

export function createServerHostSettings(core: CoreCaller): ServerHostSettings {
  let access = new Map<string, ServerModelAccess>();
  return {
    refresh: async () => {
      const hosts = (await core.call('connections/ssh/list', {})) as SshHost[] | null;
      if (!Array.isArray(hosts)) return;
      access = new Map(
        hosts.map((host) => [
          host.id,
          {
            serverLogin: host.settings?.modelLogin === 'server',
            allowedProviders: Array.isArray(host.settings?.allowedProviders) ? host.settings.allowedProviders : null,
          },
        ])
      );
    },
    modelAccess: (id) => access.get(id) ?? NO_LIMIT,
  };
}
