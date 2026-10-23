import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRoutineProvenance, routineResultMessage, routineResultNotice } from './routine-result.mjs';

test('a failed result keeps its class and pause flag; a completed one never does', () => {
  const failed = routineResultMessage({ name: 'n', ok: false, text: 'raw', reason: 'network', paused: true });
  assert.equal(failed.meta.routine.reason, 'network');
  assert.deepEqual(
    [routineResultNotice(failed).routine.reason, routineResultNotice(failed).routine.paused],
    ['network', true]
  );
  const done = routineResultMessage({ name: 'n', ok: true, text: 'fine', reason: 'network', paused: true });
  assert.equal('reason' in done.meta.routine, false);
  assert.equal('paused' in done.meta.routine, false);
});

test('routine provenance keeps only kind, name, status, summary and error', () => {
  assert.deepEqual(
    normalizeRoutineProvenance({
      kind: 'webhook',
      name: ' hook ',
      status: 'failed',
      error: 'boom',
      runId: 'r1',
      runSessionId: 's1',
      delivery: 'failed',
    }),
    { kind: 'webhook', name: 'hook', status: 'failed', error: 'boom' }
  );
  assert.equal(normalizeRoutineProvenance({ kind: 'task', name: 'x', status: 'ok' }), null);
});

test('a task report carries the id of the send it answers into its notice; none when the send had none', async () => {
  const { agentTaskMessage } = await import('./routine-result.mjs');
  const base = { title: 'Dev', status: 'completed', text: 'done', taskSessionId: 'sess_dev', target: 'session' };
  const withId = agentTaskMessage({ ...base, sendId: 'atask_1' });
  assert.equal(withId.meta.routine.sendId, 'atask_1');
  assert.equal(routineResultNotice(withId).routine.sendId, 'atask_1');
  const without = agentTaskMessage(base);
  assert.equal('sendId' in without.meta.routine, false);
  assert.equal('sendId' in routineResultNotice(without).routine, false);
});
