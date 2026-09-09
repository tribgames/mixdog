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
