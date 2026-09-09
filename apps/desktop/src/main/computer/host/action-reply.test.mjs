import assert from 'node:assert/strict';
import test from 'node:test';
import { buildActionReply } from './action-reply.ts';

function context(overrides = {}) {
  return {
    command: { action: 'key' }, action: 'key',
    result: { action: 'key', verified: true, goal_verified: true },
    isMutation: true, targetWindowId: 'hwnd:0x1', logicalTargetWindowId: 'hwnd:0x1',
    windowTransition: null, settleDelayMs: 0, commandStartedAt: performance.now(), actionTimings: {},
    ...overrides,
  };
}

test('input recovery failure takes precedence over a successful native action', async () => {
  const result = await buildActionReply(async () => { throw new Error('unexpected capture'); }, context({
    inputRecoveryVerification: { ok: false },
  }));
  const payload = JSON.parse(result.text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'input_recovery_unconfirmed');
  assert.equal(payload.verdict.decision, 'escalate');
});

test('partial background delivery remains unknown in the tool reply rather than becoming a no-input refusal', async () => {
  const response = await buildActionReply(async () => { throw new Error('unexpected capture'); }, {
    command: { action: 'key', delivery: 'background' }, action: 'key',
    result: { action: 'key', code: 'background_target_hung', effect: 'unverifiable',
      delivery_accepted: null, input_may_have_executed: true },
    isMutation: true, windowTransition: null, settleDelayMs: 0,
    commandStartedAt: performance.now(), actionTimings: {},
  });
  const payload = JSON.parse(response.text);
  assert.equal(payload.ok, false);
  assert.equal(payload.delivery_accepted, null);
  assert.equal(payload.input_may_have_executed, true);
  assert.equal(payload.goal_verified, false);
});

test('confirmed close does not capture a different window after its target disappeared', async () => {
  const result = await buildActionReply(async () => { throw new Error('unexpected capture'); }, context({
    command: { action: 'close_window', capture_after: true }, action: 'close_window',
    result: { action: 'close_window', verified: true },
    windowTransition: { closed_windows: [{ id: 'hwnd:0x1' }], opened_windows: [] },
  }));
  const payload = JSON.parse(result.text);
  assert.equal(payload.capture_after.skipped, true);
  assert.equal(payload.capture_after.target_reason, 'target_closed');
});
