// The saved-server list handlers of the SSH IPC: rename, per-server settings and
// forget. Each answers with the refreshed list.
import type { DesktopSshHost } from '../../shared/contract-ssh';
import { parseHostSettings, type SshHostStore } from './ssh-host-store';
import { text } from './ssh-ipc-input';

const MAX_NAME_LENGTH = 80;

export function createHostListHandlers(
  store: () => Promise<SshHostStore>,
  views: () => Promise<DesktopSshHost[]>
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
      await (await store()).updateSettings(text(id, 'id'), parseHostSettings(settings));
      return views();
    },
    async forget(id) {
      await (await store()).remove(text(id, 'id'));
      return views();
    },
  };
}
