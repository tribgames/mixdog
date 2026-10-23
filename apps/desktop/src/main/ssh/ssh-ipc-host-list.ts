// The saved-server list handlers of the SSH IPC: rename, per-server settings and
// forget. Each answers with the refreshed list.
import type { DesktopSshHost } from '../../shared/contract-ssh';
import type { SshModelLogin } from './ssh-context';
import { parseHostSettings, type SshHostStore } from './ssh-host-store';
import { text } from './ssh-ipc-input';

const MAX_NAME_LENGTH = 80;

export function createHostListHandlers(
  store: () => Promise<SshHostStore>,
  views: () => Promise<DesktopSshHost[]>,
  /** The saved model login changed: an attached server's daemon restarts in it
   *  (the user confirmed that its running sessions stop). */
  applyModelLogin?: (id: string, modelLogin: SshModelLogin) => Promise<void>
): {
  rename(id: unknown, name: unknown): Promise<DesktopSshHost[]>;
  updateSettings(id: unknown, settings: unknown): Promise<DesktopSshHost[]>;
  forget(id: unknown): Promise<DesktopSshHost[]>;
} {
  return {
    async rename(id, name) {
      const label = String(name ?? '')
        .trim()
        .slice(0, MAX_NAME_LENGTH);
      if (label) await (await store()).rename(text(id, 'id'), label);
      return views();
    },
    async updateSettings(id, settings) {
      const hostId = text(id, 'id');
      const hosts = await store();
      const next = parseHostSettings(settings);
      const savedLogin = (): SshModelLogin => (hosts.get(hostId)?.settings?.modelLogin === 'server' ? 'server' : 'pc');
      const before = savedLogin();
      await hosts.updateSettings(hostId, next);
      const after = savedLogin();
      // The restart runs behind the server's windows; its progress and any
      // failure show in their link state, not as a failed save.
      if (before !== after) void applyModelLogin?.(hostId, after).catch(() => undefined);
      return views();
    },
    async forget(id) {
      await (await store()).remove(text(id, 'id'));
      return views();
    },
  };
}
