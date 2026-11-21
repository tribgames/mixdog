/**
 * `host/computer/processFate`: the OS's answer about one process, read by the desktop's own computer host. The core asks it to
 * bind a saved-login owner to its process when the desktop runs the commands: the worker's `process_fate` is no command a
 * bridge caller may send, so it has its own method, which takes a process alone and never a session or a command.
 */
import type {
  HostComputerProcessFateParams,
  HostComputerProcessFateResult,
} from '../../../../../packages/protocol/src/index.ts';
import type { ReadProcessFate } from '../computer/host/process-fate';
import { COMPUTER_UNAVAILABLE } from './computer';
import {
  HOST_COMMAND_FAILED,
  HOST_INVALID_PARAMS,
  HostRpcError,
  type HostConnection,
  objectParams,
} from './connection';

export const HOST_COMPUTER_PROCESS_FATE = 'host/computer/processFate';

/** The host while the desktop's PowerShell Windows host runs, else null. */
export type ProcessFateSource = () => { readProcessFate: ReadProcessFate } | null;

export function registerComputerProcessFate(connection: HostConnection, source: ProcessFateSource): void {
  connection.handleRequest(HOST_COMPUTER_PROCESS_FATE, async (params): Promise<HostComputerProcessFateResult> => {
    const { pid, created } = objectParams<HostComputerProcessFateParams>(params, HOST_COMPUTER_PROCESS_FATE);
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || typeof created !== 'string') {
      throw new HostRpcError(
        HOST_INVALID_PARAMS,
        `${HOST_COMPUTER_PROCESS_FATE} needs a positive integer pid and a created string.`
      );
    }
    const host = source();
    if (!host) throw new HostRpcError(HOST_COMMAND_FAILED, COMPUTER_UNAVAILABLE);
    return await host.readProcessFate({ pid, created });
  });
}
