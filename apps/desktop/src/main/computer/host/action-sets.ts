/**
 * Action classification for the Computer Use host: which commands read, which
 * mutate, which need a fresh observation, and which lanes they run on.
 */
import type { ComputerCommand } from '../shared/types';

/** The session the bridge warms up under, before any caller exists. */
export const HOST_WARMUP_SESSION_ID = '__computer_host_warmup__';

export const OBSERVATION_BOUND_INPUT_ACTIONS = new Set([
  'invoke', 'set_value', 'toggle',
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'mouse_move', 'drag', 'type', 'key', 'scroll',
]);
export const FOCUS_CONTINUATION_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'drag', 'scroll',
]);
export const AUTO_CAPTURE_ACTIONS = new Set([
  ...OBSERVATION_BOUND_INPUT_ACTIONS,
  'focus_window', 'move_window', 'window_state', 'close_window', 'launch', 'invoke_menu',
]);
export const READ_ACTIONS = new Set([
  'list_windows', 'list_apps', 'snapshot', 'find', 'capture', 'clipboard_read', 'wait',
  'window_bounds', 'screenshot', 'zoom', 'verify', 'window_predicates',
]);

// Observation-only mode keeps every state read available and refuses anything
// that could change the desktop, before the command reaches a dispatch path.
export const OBSERVE_ONLY_ALLOWED_ACTIONS = new Set([
  'list_windows', 'list_apps', 'diagnose', 'capture', 'zoom', 'clipboard_read', 'wait',
  'verify', 'window_predicates',
  'snapshot', 'find', 'screenshot', 'window_bounds', 'window_snapshot', 'related_windows',
  'window_capture', 'window_integrity', 'input_recovery_state', 'ocr_image', 'ocr_status',
  'execution_end', 'session_release', 'session_abort',
]);

export function isComputerLifecycleControl(command: ComputerCommand): boolean {
  return ['execution_end', 'session_release', 'session_abort'].includes(
    String(command.action || ''),
  );
}

export function requiresForegroundLane(command: ComputerCommand): boolean {
  const action = String(command.action || '');
  return command.delivery === 'foreground'
    || action === 'focus_window'
    || action === 'launch'
    || action === 'invoke_menu'
    || action === 'move_window'
    || action === 'window_state'
    || action === 'close_window'
    || action === 'clipboard_read'
    || action === 'clipboard_write';
}
