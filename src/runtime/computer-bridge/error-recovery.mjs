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

function recoveryForCode(code, args) {
  const target = targetLabel(args);
  if (code === 'ambiguous_window_target' || code === 'window_stale'
    || code === 'window_target_not_found') {
    return {
      code,
      next: 'list',
      guidance: 'List windows and retry with one current exact window_id.',
    };
  }
  if (code === 'stale_frame' || code === 'stale_target' || code === 'target_mismatch') {
    return {
      code,
      next: 'capture',
      guidance: `Capture ${target} again and use only the fresh ref, OCR mark, or frame_id.`,
    };
  }
  if (code === 'computer_target_available_recapture_required'
    || code === 'computer_foreground_available_recapture_required'
    || code === 'computer_target_in_use') {
    return {
      code,
      next: 'capture',
      guidance: code === 'computer_target_in_use'
        ? `Another session owns ${target}. Do not retry the stale action; wait for its lease to release, then capture fresh state.`
        : code === 'computer_foreground_available_recapture_required'
          ? `The foreground lane is now available. Capture ${target} again before issuing any input.`
          : `The target lease is now available. Capture ${target} again before issuing any input.`,
    };
  }
  if (code === 'computer_user_control_active' || code === 'computer_user_takeover') {
    return {
      code,
      next: 'user',
      guidance: 'The user has taken control. Do not issue more Computer Use commands until they explicitly resume automation.',
    };
  }
  if (code.startsWith('menu_') || code === 'computer_command_timeout') {
    return {
      code,
      next: 'capture',
      guidance: `Capture ${target} again; empty accessibility automatically uses OCR. Use a fresh OCR mark or frame point and do not retry the same menu path unchanged.`,
    };
  }
  if (code === 'foreground_changed') {
    return {
      code,
      next: 'user',
      guidance: 'Foreground control changed during dispatch, so Computer Use paused for the user. Wait for an explicit resume.',
    };
  }
  if (code === 'foreground_unavailable') {
    return {
      code,
      next: 'foreground_pointer',
      guidance: 'This is a Windows foreground-lock failure, not a permission error. Activate the fresh target with a foreground pointer action, then retry keyboard input only after it is focused.',
    };
  }
  if (code.startsWith('background_')) {
    return {
      code,
      next: 'foreground',
      guidance: `Capture ${target} again and retry the action with delivery="foreground".`,
    };
  }
  if (code === 'pixel_unavailable' || code === 'observation_unavailable') {
    return {
      code,
      next: 'capture',
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
