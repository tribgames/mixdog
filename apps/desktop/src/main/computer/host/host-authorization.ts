/**
 * The host's authorization reads: the window list the authorization settings
 * offer, and the gate every capture passes before any pixels are read.
 */
import type { ComputerAuthorizationWindow } from '../../../shared/computer-settings';
import type { ComputerCommand } from '../shared/types';
import type { ComputerWindowRecord } from '../shared/window-transition';
import { CHROME_SETUP_SESSION_ID } from '../shared/common';
import type { ComputerExecutionPolicy } from './execution-policy';
import type { ReadProcessFate } from './process-fate';
import { assertSavedLoginPixelsAllowed } from './saved-login';

type ReadComputerWindows = (command: ComputerCommand, includeApp?: boolean) => Promise<ComputerWindowRecord[] | null>;

/** The current app windows, as the authorization settings list them. */
export async function listAuthorizationWindows(
  readComputerWindows: ReadComputerWindows
): Promise<ComputerAuthorizationWindow[]> {
  const windows = await readComputerWindows({ action: 'list_windows', session_id: 'computer-settings' }, true);
  if (!windows) throw new Error('computer_windows_unavailable: could not read current app windows');
  return windows.map(({ id, pid, app, title }) => ({ id, pid, app, title }));
}

/** The live process id owning `windowId`, read for `command`'s session. */
async function readWindowOwnerPid(
  readComputerWindows: ReadComputerWindows,
  command: ComputerCommand,
  windowId: string
): Promise<string | undefined> {
  const windows = await readComputerWindows(command);
  const owner = windows?.find((window) => String(window.id).toLowerCase() === windowId.toLowerCase());
  return owner?.pid ? String(owner.pid) : undefined;
}

export function createCaptureAuthorizer(host: {
  policy: Pick<ComputerExecutionPolicy, 'restricted' | 'assertWindow'>;
  readComputerWindows: ReadComputerWindows;
  sessionIdFor(command: ComputerCommand): string;
  processFate: ReadProcessFate;
}): (command: ComputerCommand, windowId: string) => Promise<void> {
  const { policy, readComputerWindows, sessionIdFor, processFate } = host;
  return async (command, windowId) => {
    // Before any policy decision, for every session: no pixels of a browser a
    // saved-login password was filled into leave the host until the filling
    // turn ends, however the capture was reached (explicit read,
    // capture-after, zoom). The target's process is read live; unreadable
    // refuses.
    await assertSavedLoginPixelsAllowed(
      command,
      windowId,
      (id) => readWindowOwnerPid(readComputerWindows, command, id),
      undefined,
      processFate
    );
    if (!policy.restricted || sessionIdFor(command) === CHROME_SETUP_SESSION_ID) return;
    if (!windowId) throw new Error('computer_policy_denied: full-screen capture is not authorized');
    policy.assertWindow({ ...command, action: 'capture', window_id: windowId }, await readComputerWindows(command));
  };
}
