import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingWorkReply } from './pending-work.ts';

test('a failed resume observation cannot authorize continuation or erase uncertainty', () => {
  const result = pendingWorkReply(
    { action: 'sequence', steps: [{ action: 'type' }, { action: 'key' }] },
    { text: JSON.stringify({ observation: { ok: false, action: 'capture' } }) },
    { completed: 0, inFlight: 0 },
  );
  const payload = JSON.parse(result.text);
  assert.equal(payload.ok, false);
  assert.equal(payload.verdict.recommended, 'recapture');
  assert.deepEqual(payload.steps.map((step) => step.status), ['uncertain', 'pending']);
  assert.match(payload.recovery.guidance, /Never resend it blindly/);
});

test('completed input awaiting its final observation has no remaining input to replay', () => {
  const result = pendingWorkReply(
    { action: 'sequence', steps: [{ action: 'type' }] },
    { text: JSON.stringify({ observation: { ok: true, action: 'capture' } }) },
    { completed: 1 },
  );
  const payload = JSON.parse(result.text);
  assert.equal(payload.completed, true);
  assert.deepEqual(payload.pending_work.pending_steps, []);
  assert.equal(payload.pending_work.uncertain_step, undefined);
});
