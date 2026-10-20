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
