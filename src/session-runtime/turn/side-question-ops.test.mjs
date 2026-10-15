import assert from 'node:assert/strict';
import test from 'node:test';
import { beginSideQuestion } from '../../runtime/agent/orchestrator/session/side-question-store.mjs';
import { createSideQuestionOps } from './side-question-ops.mjs';

test('cancelSide aborts the named session side question, else the current one', () => {
  const previous = beginSideQuestion('side-ops-previous');
  const current = beginSideQuestion('side-ops-current');
  const ops = createSideQuestionOps({ getSession: () => ({ id: 'side-ops-current' }) });

  // After a session switch the pending ask belongs to the previous session.
  ops.cancelSide('side-ops-previous');
  assert.equal(previous.signal.aborted, true);
  assert.equal(current.signal.aborted, false);

  ops.cancelSide();
  assert.equal(current.signal.aborted, true);
  previous.end();
  current.end();
});
