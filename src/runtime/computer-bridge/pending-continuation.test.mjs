import assert from 'node:assert/strict';
import test from 'node:test';
import { continuePendingComputerWork } from './pending-continuation.mjs';

const value = (data) => ({ text: JSON.stringify(data) });
const pending = value({
  ok: true,
  action: 'sequence',
  status: 'paused',
  code: 'computer_user_intervention_pending',
  reason: 'user_input_active',
  fresh_capture_required: true,
  verdict: { decision: 'wait_for_user', recommended: 'wait_for_user' },
  completed: false,
  completed_steps: 1,
  total_steps: 3,
  input_replayed: false,
  pending_work: { completed_steps: 1, uncertain_step: 2, pending_steps: [3] },
});

test('long human interaction stays pending across waits then returns fresh state and preserved progress', async () => {
  const calls = [];
  let waits = 0;
  const result = await continuePendingComputerWork(
    pending,
    { action: 'sequence', window_id: 'hwnd:0x1' },
    async (command) => {
      calls.push(command);
      if (command.action === 'wait_for_user') {
        return value(
          ++waits < 3 ? { status: 'timeout', reason: 'user_input_active' } : { status: 'resumed', resumed: true }
        );
      }
      return { ...value({ ok: true, frame_id: 'fresh' }), image: { data: 'image', mimeType: 'image/png' } };
    }
  );
  assert.deepEqual(
    calls.map((c) => c.action),
    ['wait_for_user', 'wait_for_user', 'wait_for_user', 'capture']
  );
  const body = JSON.parse(result.text);
  assert.equal(body.status, 'resumed');
  assert.equal(body.observation.frame_id, 'fresh');
  assert.deepEqual(body.pending_work, JSON.parse(pending.text).pending_work);
  assert.equal(body.input_replayed, false);
  assert.equal(body.recovery.next, 'continue_pending_work');
  assert.equal(body.code, undefined);
  assert.equal(body.reason, '');
  assert.equal(body.completed, false);
  assert.deepEqual(body.verdict, { decision: 'verify_fresh_state', recommended: 'continue_pending_work' });
  assert.equal(result.image.data, 'image');
});

test('confirmed resume reports already completed input without replaying it', async () => {
  const calls = [];
  const result = await continuePendingComputerWork(
    value({
      ...JSON.parse(pending.text),
      action: 'focus_window',
      completed_steps: 1,
      total_steps: 1,
      pending_work: { completed_steps: 1, pending_steps: [] },
    }),
    { action: 'focus_window', window_id: 'hwnd:0x1' },
    async (command) => {
      calls.push(command.action);
      return value(command.action === 'wait_for_user'
        ? { status: 'resumed', resumed: true }
        : { ok: true, frame_id: 'after-focus' });
    }
  );
  const body = JSON.parse(result.text);
  assert.deepEqual(calls, ['wait_for_user', 'capture']);
  assert.equal(body.status, 'resumed');
  assert.equal(body.completed, true);
  assert.equal(body.code, undefined);
  assert.equal(body.input_replayed, false);
  assert.deepEqual(body.verdict, { decision: 'verify_fresh_state', recommended: 'continue_pending_work' });
});

test('confirmed resume without a known target requests capture instead of another user wait', async () => {
  const result = await continuePendingComputerWork(pending, { action: 'launch' }, async (command) => {
    assert.equal(command.action, 'wait_for_user');
    return value({ status: 'resumed', resumed: true });
  });
  const body = JSON.parse(result.text);
  assert.equal(body.status, 'resumed');
  assert.equal(body.reason, '');
  assert.equal(body.code, undefined);
  assert.equal(body.completed, false);
  assert.equal(body.fresh_capture_required, true);
  assert.equal(body.recovery.next, 'capture');
  assert.deepEqual(body.verdict, { decision: 'escalate', recommended: 'recapture' });
});

test('failed post-resume observation requests recapture without claiming user control is still active', async () => {
  const result = await continuePendingComputerWork(pending, { window_id: 'hwnd:0x1' }, async (command) =>
    value(command.action === 'wait_for_user'
      ? { status: 'resumed', resumed: true }
      : { ok: false, code: 'capture_source_unavailable' })
  );
  const body = JSON.parse(result.text);
  assert.equal(body.ok, false);
  assert.equal(body.status, 'resumed');
  assert.equal(body.code, undefined);
  assert.equal(body.observation.code, 'capture_source_unavailable');
  assert.equal(body.fresh_capture_required, true);
  assert.equal(body.recovery.next, 'capture');
  assert.deepEqual(body.verdict, { decision: 'escalate', recommended: 'recapture' });
});

test('another intervention during recapture re-enters waiting without sending any input', async () => {
  let captures = 0;
  const result = await continuePendingComputerWork(pending, { window_id: 'hwnd:0x1' }, async (command) => {
    assert.ok(['wait_for_user', 'capture'].includes(command.action));
    if (command.action === 'wait_for_user') return value({ status: 'resumed', resumed: true });
    return ++captures === 1 ? pending : value({ ok: true, frame_id: 'second' });
  });
  assert.equal(captures, 2);
  assert.equal(JSON.parse(result.text).observation.frame_id, 'second');
});

test('explicit stop ends pending work, while cancellation never sends another request', async () => {
  const stopped = await continuePendingComputerWork(pending, {}, async () =>
    value({ status: 'cancelled', reason: 'user_stop' })
  );
  assert.equal(JSON.parse(stopped.text).status, 'cancelled');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    continuePendingComputerWork(pending, {}, async () => assert.fail('no request after abort'), controller.signal)
  );
});

test('a read failure returns retained progress rather than losing the unfinished intent', async () => {
  const result = await continuePendingComputerWork(pending, { window_id: 'hwnd:0x1' }, async () => {
    throw new Error('connection failed');
  });
  const body = JSON.parse(result.text);
  assert.equal(body.code, 'computer_pending_read_failed');
  assert.equal(body.status, 'paused');
  assert.equal(body.input_replayed, false);
  assert.deepEqual(body.pending_work, JSON.parse(pending.text).pending_work);
});
