/** Which commands the loopback bridge accepts from a caller: the public ones, never an internal session or an
 *  internal execution authority. The core answers the same refusal for a command that reaches it. */
import {
  computerActionHas,
  computerActionsWith,
} from '../../../shared/core-src/runtime/computer-bridge/actions.mjs';
import { CHROME_SETUP_SESSION_ID, USER_WAIT_SESSION_ID, WINDOW_ARRIVALS_SESSION_ID } from '../shared/common';

/** The session the helper warms up under, before any caller exists. */
const HOST_WARMUP_SESSION_ID = '__computer_host_warmup__';

const READ_ACTIONS = new Set(computerActionsWith('hostRead'));
const AUTO_CAPTURE_ACTIONS = new Set(computerActionsWith('autoCapture'));
const OTHER_PUBLIC_ACTIONS = new Set([
  'sequence',
  'diagnose',
  'clipboard_write',
  'secret_bind',
  'secret_input',
  'fill_saved_login',
]);
const INTERNAL_AUTHORITY_FIELDS = [
  'known_injection_tick',
  'authorization_expires_at',
  'authorization_window_id',
  'authorization_pid',
  'expected_input_tick',
  'expected_input_monitor_id',
  'expected_input_user_sequence',
];

/** The lifecycle controls (execution end, session release and abort, turn settlement). */
export function isLifecycleControl(command: { action?: unknown }): boolean {
  return computerActionHas(String(command.action || ''), 'lifecycle');
}

/** One command of the bridge's wire shape: an object with `action`, the action's fields and `session_id`. */
export interface BridgeCommand {
  action: string;
  session_id?: unknown;
  runtime_id?: unknown;
  [field: string]: unknown;
}

/** Throws why `value` is not a command a bridge caller may send. */
export function assertPublicComputerRequest(value: unknown): asserts value is BridgeCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_request: computer command must be an object');
  }
  const command = value as BridgeCommand;
  if (
    command.session_id === CHROME_SETUP_SESSION_ID ||
    command.session_id === HOST_WARMUP_SESSION_ID ||
    command.session_id === USER_WAIT_SESSION_ID ||
    command.session_id === WINDOW_ARRIVALS_SESSION_ID ||
    INTERNAL_AUTHORITY_FIELDS.some((field) => Object.hasOwn(command, field))
  ) {
    throw new Error('computer_policy_denied: internal execution authority cannot be supplied by a bridge caller');
  }
  if (
    !READ_ACTIONS.has(command.action) &&
    !AUTO_CAPTURE_ACTIONS.has(command.action) &&
    !OTHER_PUBLIC_ACTIONS.has(command.action) &&
    !isLifecycleControl(command)
  ) {
    throw new Error('invalid_action: computer bridge action is not available');
  }
}
