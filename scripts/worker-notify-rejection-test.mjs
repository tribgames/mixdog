// The owner/worker notifyFn wrapper must not mask a Promise-returning upstream
// notifyFn as a settled sync success. When the upstream promise REJECTS, the
// owner-session enqueue fallback must still fire so the completion is delivered
// rather than silently swallowed. A truthy resolve never enqueues (exact-once).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createNotify } from '../src/standalone/agent-tool/notify.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const meta = { type: 'agent_task_result', execution_id: 'task_1', status: 'completed' };
// A terminal completion text with a Result body — required for the model-visible
// completion to persist through the owner-session enqueue.
const doneText = 'Async agent task task_1 completed finished.\n\nResult:\n> ok';

function makeMgr() {
  const enqueued = [];
  return {
    enqueued,
    enqueuePendingMessage(target, entry) { enqueued.push({ target, entry }); return 1; },
  };
}

test('async upstream notifyFn rejection falls back to owner enqueue', async () => {
  const mgr = makeMgr();
  const { workerNotifyFn } = createNotify(mgr);
  const notify = workerNotifyFn('sess_owner', {
    callerSessionId: 'sess_owner',
    notifyFn: () => Promise.reject(new Error('boom')),
  });
  const result = notify(doneText, meta);
  assert.equal(result, true, 'optimistically reported delivered while in flight');
  assert.equal(mgr.enqueued.length, 0, 'no sync fallback before settlement');
  await tick();
  await tick();
  assert.equal(mgr.enqueued.length, 1, 'rejection rescued via owner enqueue fallback');
  assert.equal(mgr.enqueued[0].target, 'sess_owner');
});

test('async upstream notifyFn truthy resolve never enqueues (exact-once)', async () => {
  const mgr = makeMgr();
  const { workerNotifyFn } = createNotify(mgr);
  const notify = workerNotifyFn('sess_owner', {
    callerSessionId: 'sess_owner',
    notifyFn: () => Promise.resolve(true),
  });
  notify(doneText, meta);
  await tick();
  await tick();
  assert.equal(mgr.enqueued.length, 0, 'successful async delivery does not double-enqueue');
});
