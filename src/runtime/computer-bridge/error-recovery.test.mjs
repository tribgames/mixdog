import assert from 'node:assert/strict';
import test from 'node:test';
import { computerResultRecovery, computerToolErrorRecovery } from './error-recovery.mjs';

test('mode failures do not instruct a blind retry or a delivery switch', () => {
  const input = { input: { window_id: 'hwnd:0x1', delivery: 'foreground' } };
  assert.equal(computerResultRecovery({ code: 'foreground_unavailable' }, input).next, 'user');
  assert.equal(computerResultRecovery({ code: 'background_unsupported' }, input).next, 'capture');
  for (const code of ['input_cleanup_unconfirmed', 'privileged_worker_cleanup_unconfirmed']) {
    assert.equal(computerToolErrorRecovery(`${code}: failed`, input).next, 'user');
  }
  assert.equal(computerToolErrorRecovery('computer_cursor_unavailable: no input sent', input).next, 'diagnose');
});

test('window, lease and user-yield codes keep their next actions', () => {
  const input = { input: { app: 'Notepad' } };
  assert.equal(computerResultRecovery({ code: 'window_stale' }, input).next, 'list');
  assert.equal(computerResultRecovery({ code: 'stale_frame' }, input).next, 'capture');
  assert.match(computerResultRecovery({ code: 'computer_target_in_use' }, input).guidance, /Another session owns app "Notepad"/);
  assert.equal(computerResultRecovery({ code: 'computer_user_control_active' }, input).next, 'wait_for_user');
  assert.equal(computerResultRecovery({ code: 'pixel_unavailable' }, input).next, 'capture');
  assert.equal(computerResultRecovery({ code: 'unknown_code' }, input), undefined);
});
