// The cleanup of a saved server: closes its window, removes Mixdog from it over
// ssh (retrying a refused login through the askpass helper) and, when asked,
// forgets the server.
import type { IpcMainInvokeEvent } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract-ipc';
import type {
  DesktopSshCleanupProgress,
  DesktopSshCleanupRequest,
  DesktopSshCleanupResult,
  DesktopSshHost,
} from '../../shared/contract-ssh';
import type { ConnectionManager } from '../connections/contract';
import { describeConnectFailure } from './connect-failure';
import { parseSshTarget, sshTargetLabel } from './ssh-command';
import { runWithSshContext, type SshRunContext } from './ssh-context';
import type { SshHostRecord, SshHostStore } from './ssh-host-store';
import { text } from './ssh-ipc-input';
import type { createLoginRetry } from './ssh-ipc-login';

export interface CleanupDeps {
  connections: Pick<ConnectionManager, 'isOpen' | 'close'>;
  store(): Promise<SshHostStore>;
  views(): Promise<DesktopSshHost[]>;
  contextFor(record: SshHostRecord, extra?: SshRunContext): SshRunContext;
  withLogin: ReturnType<typeof createLoginRetry>;
  /** Removes Mixdog from the server. */
  cleanupServer(
    target: string,
    options: {
      removeUserData: boolean;
      onProgress?: (progress: { phase: DesktopSshCleanupProgress['phase']; detail?: string }) => void;
    }
  ): Promise<unknown>;
  platform: NodeJS.Platform;
}

export function createCleanupHandler(
  deps: CleanupDeps
): (event: IpcMainInvokeEvent, id: unknown, rawRequest: unknown) => Promise<DesktopSshCleanupResult> {
  const { connections, platform } = deps;
  return async (event, id, rawRequest) => {
    const request = rawRequest as Partial<DesktopSshCleanupRequest> | undefined;
    const operationId = text(request?.operationId, 'operationId');
    const hosts = await deps.store();
    const record = hosts.get(text(id, 'id'));
    if (!record) throw new Error('This SSH server is no longer saved.');
    const target = parseSshTarget(record.target);
    const removeUserData = request?.removeUserData === true;
    const run = async (context: SshRunContext): Promise<DesktopSshCleanupResult> => {
      try {
        // The server's window goes first: its daemon is about to be removed.
        if (connections.isOpen(record.id)) await connections.close(record.id);
        const done = await runWithSshContext(deps.contextFor(record, context), () =>
          deps.cleanupServer(record.target, {
            removeUserData,
            onProgress: (progress) => {
              if (event.sender.isDestroyed()) return;
              const payload: DesktopSshCleanupProgress = { operationId, ...progress };
              event.sender.send(DESKTOP_IPC.sshCleanupProgress, payload);
            },
          })
        );
        return { ok: true, hosts: [], ...(typeof done === 'string' && done ? { detail: done } : {}) };
      } catch (error) {
        return { ok: false, failure: describeConnectFailure(error, target, platform) };
      }
    };
    const result = await deps.withLogin(event.sender, operationId, sshTargetLabel(target), {}, run, () => false);
    if (result.ok && request?.forget === true) await hosts.remove(record.id);
    return result.ok ? { ...result, hosts: await deps.views() } : result;
  };
}
