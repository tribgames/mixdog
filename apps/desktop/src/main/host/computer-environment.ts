/**
 * The desktop transitions that invalidate what a Computer Use session saw (the screen locks, the machine suspends, a display is
 * added, removed or changes its geometry) reported to the core as a `takeover` of the user's hold (`computer/userControl`).
 * The event set is the old guard's (`bindComputerEnvironmentGuard`), reused as it is; nothing resumes by itself.
 */
import type { ComputerUserControlParams, ComputerTakeoverReason } from '../../../../../packages/protocol/src/index.ts';
import { bindComputerEnvironmentGuard } from '../computer/host/environment-guard';
import { COMPUTER_USER_CONTROL, type CallCore } from './computer-user-control';

type EventSource = Parameters<typeof bindComputerEnvironmentGuard>[0];

/** Starts the reports; the returned function stops them. A failed send is reported once per transition, never thrown into Electron. */
export function bindComputerEnvironment(
  power: EventSource,
  screen: EventSource,
  callCore: CallCore,
  onError: (error: unknown) => void = () => undefined
): () => void {
  return bindComputerEnvironmentGuard(power, screen, (reason) => {
    const params: ComputerUserControlParams = { action: 'takeover', reason: reason as ComputerTakeoverReason };
    callCore(COMPUTER_USER_CONTROL, params).catch(onError);
  });
}
