import { CHROME_SETUP_SESSION_ID } from '../session/chrome-setup';
import { AUTO_CAPTURE_ACTIONS, READ_ACTIONS, HOST_WARMUP_SESSION_ID, isComputerLifecycleControl } from './action-sets';
import type { ComputerCommand } from '../shared/types';
import { USER_WAIT_SESSION_ID } from './user-wait-service';

/** Internal authority is never accepted from an authenticated HTTP payload. */
export function assertPublicComputerRequest(value: unknown): asserts value is ComputerCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_request: computer command must be an object');
  }
  const command = value as ComputerCommand;
  if (command.session_id === CHROME_SETUP_SESSION_ID || command.session_id === HOST_WARMUP_SESSION_ID
    || command.session_id === USER_WAIT_SESSION_ID
    || ['known_injection_tick', 'authorization_expires_at', 'authorization_window_id', 'authorization_pid', 'expected_input_tick',
      'expected_input_monitor_id', 'expected_input_user_sequence']
      .some((field) => Object.prototype.hasOwnProperty.call(command, field))) {
    throw new Error('computer_policy_denied: internal execution authority cannot be supplied by a bridge caller');
  }
  if (!READ_ACTIONS.has(command.action) && !AUTO_CAPTURE_ACTIONS.has(command.action)
    && !['sequence', 'diagnose', 'clipboard_write'].includes(command.action)
    && !isComputerLifecycleControl(command)) {
    throw new Error('invalid_action: computer bridge action is not available');
  }
}
