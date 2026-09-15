function errorCode(message) {
  const text = String(message || '').trim().replace(/^Error:\s*/i, '');
  const explicit = /^([a-z][a-z0-9_]+):/i.exec(text);
  if (explicit) return explicit[1].toLowerCase();
  if (/window_id is stale|window is stale/i.test(text)) return 'window_stale';
  if (/fresh capture.*first|unknown frame_id/i.test(text)) return 'stale_frame';
  return '';
}

function targetLabel(args) {
  const input = args?.input || {};
  if (input.window_id) return `window ${input.window_id}`;
  if (input.app) return `app "${input.app}"`;
  return 'the exact target window';
}

const LIST_WINDOW_CODES = new Set([
  'ambiguous_window_target', 'window_stale', 'window_target_not_found',
]);
const STALE_TARGET_CODES = new Set(['stale_frame', 'stale_target', 'target_mismatch']);
const USER_YIELD_CODES = new Set([
  'computer_user_control_active', 'computer_user_takeover', 'user_input_active',
]);
const DIAGNOSE_CODES = new Set([
  'input_observation_unavailable', 'input_recovery_unconfirmed', 'computer_cursor_unavailable',
]);
const CLEANUP_CODES = new Set([
  'computer_cleanup_pending', 'computer_abort_cleanup_unconfirmed',
  'input_cleanup_unconfirmed', 'privileged_worker_cleanup_unconfirmed',
]);
const PIXEL_CODES = new Set(['pixel_unavailable', 'observation_unavailable']);

function recaptureLeaseGuidance(code, target) {
  if (code === 'computer_target_in_use') {
    return `Another session owns ${target}. Do not retry the stale action; wait for its lease to release, then capture fresh state.`;
  }
  if (code === 'computer_foreground_available_recapture_required') {
    return `The foreground lane is now available. Capture ${target} again before issuing any input.`;
  }
  return `The target lease is now available. Capture ${target} again before issuing any input.`;
}

function recoveryForCode(code, args) {
  const target = targetLabel(args);
  if (LIST_WINDOW_CODES.has(code)) {
    return { code, next: 'list', guidance: 'List windows and retry with one current exact window_id.' };
  }
  if (STALE_TARGET_CODES.has(code)) {
    return {
      code, next: 'capture',
      guidance: `Capture ${target} again and use only the fresh ref, OCR mark, or frame_id.`,
    };
  }
  if (code === 'computer_target_available_recapture_required'
    || code === 'computer_foreground_available_recapture_required'
    || code === 'computer_target_in_use') {
    return { code, next: 'capture', guidance: recaptureLeaseGuidance(code, target) };
  }
  if (USER_YIELD_CODES.has(code)) {
    return {
      code, next: 'wait_for_user',
      guidance: 'Computer Use yielded to the user. Call wait_for_user for bounded waiting. Ordinary physical input may resume after the host-configured quiet interval (default 5 seconds); explicit stops and uncertain cleanup/observation require the user. Timeout does not authorize input. After resumed, capture fresh state; never replay interrupted input. Manual Resume is also available on the overlay.',
    };
  }
  if (DIAGNOSE_CODES.has(code)) {
    return {
      code, next: 'diagnose',
      guidance: 'Input or recovery could not be verified. Do not repeat the mutation. Diagnose the exact target and inspect fresh state only when user control is not active.',
    };
  }
  if (CLEANUP_CODES.has(code)) {
    return {
      code, next: 'user',
      guidance: 'Worker exit and input release are not confirmed. Do not resume or reset the guard; wait for cleanup. Failed cleanup requires an explicitly approved host restart.',
    };
  }
  if (code.startsWith('menu_') || code === 'computer_command_timeout') {
    return {
      code, next: 'capture',
      guidance: `Capture ${target} again; empty accessibility automatically uses OCR. Use a fresh OCR mark or frame point and do not retry the same menu path unchanged.`,
    };
  }
  if (code === 'foreground_changed') {
    return {
      code, next: 'user',
      guidance: 'Focus changed during dispatch. Do not pull it back or retry input automatically. Check user control, then obtain fresh state when control is available.',
    };
  }
  if (code === 'foreground_unavailable') {
    return {
      code, next: 'user',
      guidance: `Windows did not grant foreground focus. Ask the user to activate ${target}, then capture fresh state. Do not substitute background input or repeat the failed gesture.`,
    };
  }
  if (code.startsWith('background_')) {
    return {
      code, next: 'capture',
      guidance: `Capture ${target} and inspect whether any input was delivered. Consider foreground only if no input was sent and visible control is within the user's scope; never silently change delivery or replay uncertain input.`,
    };
  }
  if (PIXEL_CODES.has(code)) {
    return {
      code, next: 'capture',
      guidance: `Recapture ${target}; do not use coordinates until a fresh frame reports pixel_status="available".`,
    };
  }
  return undefined;
}

export function computerToolErrorRecovery(message, args = {}) {
  return recoveryForCode(errorCode(message), args);
}

export function computerResultRecovery(result, args = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  return recoveryForCode(String(result.code || '').toLowerCase(), args);
}

export function formatComputerToolError(message, args = {}) {
  const text = String(message || 'computer bridge request failed');
  const recovery = computerToolErrorRecovery(text, args);
  return `Error: ${text}${recovery ? `\nRecovery: ${recovery.guidance}` : ''}`;
}
