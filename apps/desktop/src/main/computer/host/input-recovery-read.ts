/**
 * The foreground input-recovery baseline: which window holds focus, where the
 * pointer is, and the input observer's position, read before a foreground
 * delivery so the same state can be verified or restored afterwards.
 */
import type { ComputerCommand } from '../shared/types';
import type { InputRecoveryState } from './execution-state';
import type { InputResolutionHost } from './input-resolution';

export type InputRecoveryReadHost = Pick<InputResolutionHost, 'callPowerShell' | 'sessionIdFor'>;

export async function readInputRecovery(
  host: InputRecoveryReadHost,
  command: ComputerCommand,
  targetWindowId: string | undefined,
  includeRef = true
): Promise<InputRecoveryState> {
  const response = await host.callPowerShell({
    action: 'input_recovery_state',
    window: command.window ?? null,
    window_id: targetWindowId ?? null,
    ref: includeRef ? (command.ref ?? null) : null,
    after_input: !includeRef,
    session_id: host.sessionIdFor(command),
    read_only: true,
  });
  if (!response.ok) throw new Error(response.error || 'foreground input recovery lookup failed');
  const result = response.result || {};
  const recovery: InputRecoveryState = {
    targetWindowId: String(result.target_window_id || ''),
    targetExists: typeof result.target_exists === 'boolean' ? result.target_exists : undefined,
    targetOwnerWindowId: String(result.target_owner_window_id || ''),
    foregroundWindowId: String(result.foreground_window_id || ''),
    restoreWindowId: String(result.restore_window_id || result.foreground_window_id || ''),
    restoreOwnerWindowId: String(result.restore_owner_window_id || ''),
    cursorX: Number(result.cursor_x),
    cursorY: Number(result.cursor_y),
    inputTick: Number(result.input_tick),
    inputObserverReady: result.input_observer_ready === true,
    inputMonitorId: typeof result.input_monitor_id === 'string' ? result.input_monitor_id : '',
    inputUserSequence: Number(result.input_user_sequence),
    syntheticInput: result.synthetic_input === true,
    foregroundWithinTarget: result.foreground_within_target === true,
    foregroundChildProcess: result.foreground_child_process === true,
  };
  if (!recovery.targetWindowId || !Number.isFinite(recovery.cursorX) || !Number.isFinite(recovery.cursorY)) {
    throw new Error('foreground input recovery state is incomplete; no input was sent');
  }
  return recovery;
}
