/** Plan the same keyboard grammar and text route that dispatch will execute. */
import { normalizeComputerKeySequence } from '../input/keyboard';
import type { ComputerCommand, PowerShellResponse } from '../shared/types';
import { electronKeyPresses } from './input-electron-keys';

/** Text, keys and wheel for an app-owned Electron window go through its own input channel. */
export function canUseAppOwnedInput(command: ComputerCommand): boolean {
  return (
    (command.action === 'type' || command.action === 'key' || command.action === 'scroll') &&
    command.delivery !== 'foreground' &&
    !command.ref
  );
}

export function createInputPreflight(host: {
  callPowerShell(request: Record<string, unknown>, timeoutMs?: number): Promise<PowerShellResponse>;
  sessionIdFor(command: ComputerCommand): string;
  resolveElementAliases(command: ComputerCommand): ComputerCommand;
  isAppOwnedWindow(windowId: string): boolean;
  assertExecutionNotAborted(): void;
}) {
  return async (command: ComputerCommand, steps: ComputerCommand[]): Promise<void> => {
    if (command.delivery === 'foreground') return;
    host.assertExecutionNotAborted();
    const nativeSteps = steps
      .filter((step) => step.action === 'key' || step.action === 'type')
      .map((step) => host.resolveElementAliases(step))
      .filter((step) => {
        if (!canUseAppOwnedInput(step) || !host.isAppOwnedWindow(String(step.window_id || command.window_id || ''))) {
          return true;
        }
        // The Electron route refuses a key it cannot map before any step runs.
        if (step.action === 'key') electronKeyPresses(String(step.keys || ''));
        return false;
      })
      .map((step) => ({
        action: step.action,
        ...(step.ref ? { ref: step.ref } : {}),
        ...(step.action === 'key' ? { keys: normalizeComputerKeySequence(String(step.keys || '')) } : {}),
      }));
    if (!nativeSteps.length) return;
    const checked = await host.callPowerShell(
      {
        action: 'validate_background_input',
        window_id: command.window_id,
        session_id: host.sessionIdFor(command),
        read_only: true,
        steps: nativeSteps,
      },
      2_000
    );
    host.assertExecutionNotAborted();
    if (!checked.ok) throw new Error(checked.error || 'background_unsupported: input preflight failed; no input sent');
  };
}
