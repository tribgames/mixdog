/**
 * The desktop transitions that invalidate what a Computer Use session saw (the screen locks, the machine suspends, a display is
 * added, removed or changes its geometry) reported to the core as a `takeover` of the user's hold (`computer/userControl`).
 * The event set is the in-process guard's (`bindComputerEnvironmentGuard`), reused as it is; nothing resumes by itself.
 * A transition is reported only while the core drives the computer (`coreDrivesComputer`): while the desktop's own host runs
 * Computer Use, its in-process guard (`computer/host/powershell-host.ts`) takes over its sessions and the core is not told.
 */
import type { ComputerUserControlParams, ComputerTakeoverReason } from '../../../../../packages/protocol/src/index.ts';
import { bindComputerEnvironmentGuard } from '../computer/host/environment-guard';
import { COMPUTER_USER_CONTROL, type CallCore } from './computer-user-control';

type EventSource = Parameters<typeof bindComputerEnvironmentGuard>[0];

/** Starts the reports; the returned function stops them. A failed send is reported once per transition, never thrown into Electron.
 *  `coreDrives` is read at each transition: whether the core's own computer sessions are the ones running now. */
export function bindComputerEnvironment(
  power: EventSource,
  screen: EventSource,
  callCore: CallCore,
  coreDrives: () => boolean,
  onError: (error: unknown) => void = () => undefined
): () => void {
  return bindComputerEnvironmentGuard(power, screen, (reason) => {
    if (!coreDrives()) return;
    const params: ComputerUserControlParams = { action: 'takeover', reason: reason as ComputerTakeoverReason };
    callCore(COMPUTER_USER_CONTROL, params).catch(onError);
  });
}
