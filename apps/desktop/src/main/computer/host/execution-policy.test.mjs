import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputerExecutionPolicy, loadComputerExecutionPolicy } from './execution-policy.ts';
import { assertPublicComputerRequest } from './request-policy.ts';

const policyValue = {
  version: 1,
  actions: ['capture', 'act', 'launch'],
  windows: [{ id: 'hwnd:0x1', pid: 123 }],
  launchTargets: ['editor.exe'],
  expiresAt: '2030-01-01T00:00:00Z',
};

test('configured authority denies undeclared actions, targets, elevation and expired grants', () => {
  let now = Date.parse('2026-01-01');
  const policy = createComputerExecutionPolicy(policyValue, () => now);
  const command = { action: 'key', window_id: 'hwnd:0x1' };
  policy.assertAction(command);
  policy.assertWindow(command, [{ id: 'hwnd:0x1', pid: 123 }]);
  for (const action of ['clipboard_read', 'clipboard_write', 'close_window']) {
    assert.throws(() => policy.assertAction({ action }), /computer_policy_denied/);
  }
  assert.throws(() => policy.assertAction({ action: 'capture', app: 'editor' }), /computer_policy_denied/);
  assert.throws(() => policy.assertAction({ ...command, window_id: 'hwnd:0x2' }), /computer_policy_denied/);
  assert.throws(() => policy.assertWindow(command, [{ id: 'hwnd:0x1', pid: 999 }]), /computer_policy_denied/);
  assert.throws(() => policy.assertElevated(), /computer_policy_denied/);
  policy.assertAction({ action: 'launch', app: 'editor.exe' });
  assert.throws(() => policy.assertAction({ action: 'launch', app: 'other.exe' }), /computer_policy_denied/);
  now = Date.parse(policyValue.expiresAt);
  assert.throws(() => policy.assertAction(command), /computer_policy_expired/);
  policy.assertAction({ action: 'session_release' });
});

test('policy is immutable, invalid configuration fails closed, and no policy preserves local operation', () => {
  const value = structuredClone(policyValue);
  const policy = createComputerExecutionPolicy(value, () => 0);
  value.actions.push('clipboard_read');
  value.windows[0].pid = 999;
  assert.throws(() => policy.assertAction({ action: 'clipboard_read' }), /computer_policy_denied/);
  policy.assertWindow({ action: 'key', window_id: 'hwnd:0x1' }, [{ id: 'hwnd:0x1', pid: 123 }]);
  for (const raw of [null, {}, { ...policyValue, typo: true }, { ...policyValue, expiresAt: 'invalid' }]) {
    assert.throws(() => createComputerExecutionPolicy(raw), /computer_policy_invalid/);
  }
  assert.throws(() => loadComputerExecutionPolicy(''), /computer_policy_invalid/);
  createComputerExecutionPolicy().assertElevated();
});

test('bridge callers cannot impersonate internal sessions or supply input authority', () => {
  for (const value of [
    null, [],
    { action: 'key', session_id: '__mixdog_browser_chrome_setup__' },
    { action: 'wait', session_id: '__computer_host_warmup__' },
    { action: 'key', known_injection_tick: 123 },
    { action: 'restore_input_state' },
  ]) assert.throws(() => assertPublicComputerRequest(value));
  assertPublicComputerRequest({ action: 'sequence', session_id: 'user-session', steps: [] });
  assertPublicComputerRequest({ action: 'session_abort', session_id: 'user-session' });
});
