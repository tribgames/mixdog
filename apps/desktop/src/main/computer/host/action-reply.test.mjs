import assert from 'node:assert/strict';
import test from 'node:test';
import { buildActionReply } from './action-reply.ts';

function context(overrides = {}) {
  return {
    command: { action: 'key' },
    action: 'key',
    result: { action: 'key', verified: true, goal_verified: true },
    isMutation: true,
    targetWindowId: 'hwnd:0x1',
    logicalTargetWindowId: 'hwnd:0x1',
    windowTransition: null,
    settleDelayMs: 0,
    commandStartedAt: performance.now(),
    actionTimings: {},
    ...overrides,
  };
}

test('a native browser refusal preserves the selected browser session', async () => {
  const reply = await buildActionReply(
    async () => ({ metadata: { ok: true } }),
    context({
      command: { action: 'key', delivery: 'background' },
      result: {
        action: 'key',
        code: 'background_unsupported',
        delivery_accepted: false,
        effect: 'suspected_noop',
        verified: false,
      },
      windowTransition: {
        observed: true,
        opened_windows: [],
        closed_windows: [],
        changed_windows: [{ id: 'hwnd:0x1', app: 'chrome', className: 'Chrome_WidgetWin_1' }],
      },
    })
  );
  const payload = JSON.parse(reply.text);
  assert.equal(payload.window_id, 'hwnd:0x1');
  assert.equal(payload.verdict.recommended, 'recapture');
  assert.equal(payload.escalation, 'recapture');
});

test('input recovery failure takes precedence over a successful native action', async () => {
  const result = await buildActionReply(
    async () => {
      throw new Error('unexpected capture');
    },
    context({
      inputRecoveryVerification: { ok: false },
    })
  );
  const payload = JSON.parse(result.text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'input_recovery_unconfirmed');
  assert.equal(payload.verdict.decision, 'escalate');
});

test('partial background delivery remains unknown in the tool reply rather than becoming a no-input refusal', async () => {
  const response = await buildActionReply(
    async () => {
      throw new Error('unexpected capture');
    },
    {
      command: { action: 'key', delivery: 'background' },
      action: 'key',
      result: {
        action: 'key',
        code: 'background_target_hung',
        effect: 'unverifiable',
        delivery_accepted: null,
        input_may_have_executed: true,
      },
      isMutation: true,
      windowTransition: null,
      settleDelayMs: 0,
      commandStartedAt: performance.now(),
      actionTimings: {},
    }
  );
  const payload = JSON.parse(response.text);
  assert.equal(payload.ok, false);
  assert.equal(payload.delivery_accepted, null);
  assert.equal(payload.input_may_have_executed, true);
  assert.equal(payload.goal_verified, false);
});

test('confirmed close does not capture a different window after its target disappeared', async () => {
  const result = await buildActionReply(
    async () => {
      throw new Error('unexpected capture');
    },
    context({
      command: { action: 'close_window', capture_after: true },
      action: 'close_window',
      result: { action: 'close_window', verified: true },
      windowTransition: { closed_windows: [{ id: 'hwnd:0x1' }], opened_windows: [] },
    })
  );
  const payload = JSON.parse(result.text);
  assert.equal(payload.capture_after.skipped, true);
  assert.equal(payload.capture_after.target_reason, 'target_closed');
});

test('an accepted brokered launch with no proven window requests resolution, not relaunch or arbitrary capture', async () => {
  const reply = await buildActionReply(
    async () => { throw new Error('must not capture an unbound foreground window'); },
    context({
      command: { action: 'launch', app: 'calc.exe', capture_after: true },
      action: 'launch',
      result: {
        action: 'launch', text: 'launched calc.exe', pid: 74676, app_hint: 'calc',
        delivery_accepted: true, effect: 'unverifiable', verified: false,
      },
      logicalTargetWindowId: undefined,
      targetWindowId: undefined,
    })
  );
  const payload = JSON.parse(reply.text);
  assert.equal(payload.ok, true);
  assert.equal(payload.delivery_accepted, true);
  assert.equal(payload.goal_verified, false);
  assert.equal(payload.verified, false);
  assert.equal(payload.capture_after.skipped, true);
  assert.equal(payload.capture_after.target_reason, 'launch_target_unresolved');
  assert.equal(payload.verdict.recommended, 'list_windows');
  assert.match(payload.message, /do not launch again/);
});

test('a proven launch successor is still captured, and capture failure is not hidden', async () => {
  const calls = [];
  const reply = await buildActionReply(
    async (_command, target) => {
      calls.push(target);
      return { metadata: { ok: false, error: 'fixture capture failed' } };
    },
    context({
      command: { action: 'launch', app: 'fixture.exe', capture_after: true },
      action: 'launch',
      result: { action: 'launch', delivery_accepted: true },
      logicalTargetWindowId: undefined,
      targetWindowId: undefined,
      windowTransition: {
        observed: true, next_target: { id: 'hwnd:0x2' },
        next_target_reason: 'launched_process_window',
      },
    })
  );
  const payload = JSON.parse(reply.text);
  assert.deepEqual(calls, ['hwnd:0x2']);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'observation_unavailable');
  assert.equal(payload.delivery_accepted, true);
});

for (const structured of [true, false]) {
  test(`failed requested observation cannot finish a ${structured ? 'structured' : 'text'} action reply`, async () => {
    const result = await buildActionReply(
      async () => ({
        metadata: { ok: false, error: 'fixture observation failure' },
      }),
      context({
        command: { action: 'key', capture_after: true },
        result: structured ? { action: 'key', verified: true, delivery_accepted: true } : { text: 'delivered' },
      })
    );
    const payload = JSON.parse(result.text);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'observation_unavailable');
    assert.equal(payload.goal_verified, false);
    assert.deepEqual(payload.verdict, { decision: 'escalate', recommended: 'recapture' });
    if (structured) assert.equal(payload.delivery_accepted, true);
  });
}
