// A Promise-returning notifyFn must only *mark* a background-task completion
// delivered after the promise settles. When it rejects/declines AND the
// enqueueFallback rescue also fails, the task must be left UN-marked so a later
// reconcile can retry — never silently marked delivered before settlement.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  registerBackgroundTask,
  completeBackgroundTask,
  getBackgroundTask,
  setBackgroundTaskEnqueueFallback,
  reconcileBackgroundTask,
} from '../src/runtime/shared/background-tasks.mjs';

const tick = () => new Promise((r) => setImmediate(r));

test('async notifyFn rejection with no rescue does not mark delivered', async () => {
  setBackgroundTaskEnqueueFallback(null); // no fallback channel → nothing lands
  const task = registerBackgroundTask({
    surface: 'tool',
    operation: 'run',
    resultType: 'tool_task_result',
    context: { notifyFn: () => Promise.reject(new Error('boom')) },
  });
  completeBackgroundTask(task.taskId, { status: 'completed', resultText: 'body payload', terminalReason: 'test' });

  // Optimistic marks were applied synchronously; settlement must clear them.
  await tick();
  await tick();
  const t = getBackgroundTask(task.taskId);
  assert.equal(t.notifiedWithBody, false, 'body delivery un-marked after async failure');
  assert.equal(t.notified, false, 'notified un-marked after async failure');
});

test('async notifyFn success keeps the completion marked delivered', async () => {
  setBackgroundTaskEnqueueFallback(null);
  const task = registerBackgroundTask({
    surface: 'tool',
    operation: 'run',
    resultType: 'tool_task_result',
    context: { notifyFn: () => Promise.resolve(true) },
  });
  completeBackgroundTask(task.taskId, { status: 'completed', resultText: 'body payload', terminalReason: 'test' });

  await tick();
  await tick();
  const t = getBackgroundTask(task.taskId);
  assert.equal(t.notifiedWithBody, true, 'successful async delivery stays marked');
  assert.equal(t.notified, true, 'successful async delivery stays notified');
});

test('async notifyFn rejection is rescued by fallback and stays marked', async () => {
  const enqueued = [];
  setBackgroundTaskEnqueueFallback((sessionId, text) => { enqueued.push({ sessionId, text }); return 1; });
  const task = registerBackgroundTask({
    surface: 'tool',
    operation: 'run',
    resultType: 'tool_task_result',
    context: { notifyFn: () => Promise.reject(new Error('boom')), callerSessionId: 'sess_rescue' },
  });
  completeBackgroundTask(task.taskId, { status: 'completed', resultText: 'body payload', terminalReason: 'test' });

  await tick();
  await tick();
  const t = getBackgroundTask(task.taskId);
  assert.equal(enqueued.length, 1, 'fallback rescued the completion once');
  assert.equal(t.notifiedWithBody, true, 'rescued delivery stays marked exactly once');
});

test('reconcile retries an un-marked completion on an already-terminal task', async () => {
  // First completion: async notifyFn rejects and there is NO fallback, so the
  // task is driven terminal but the body notification un-marks itself.
  setBackgroundTaskEnqueueFallback(null);
  const task = registerBackgroundTask({
    surface: 'tool',
    operation: 'run',
    resultType: 'tool_task_result',
    context: { notifyFn: () => Promise.reject(new Error('boom')), callerSessionId: 'sess_reconcile' },
  });
  completeBackgroundTask(task.taskId, { status: 'completed', resultText: 'body payload', terminalReason: 'test' });
  await tick();
  await tick();
  const before = getBackgroundTask(task.taskId);
  assert.equal(before.notifiedWithBody, false, 'body un-marked after the failed async notify');

  // A later reconcile on the (already-terminal) task must retry the delivery
  // rather than returning early. With a working fallback now in place it lands.
  const enqueued = [];
  setBackgroundTaskEnqueueFallback((sessionId, text) => { enqueued.push({ sessionId, text }); return 1; });
  reconcileBackgroundTask(task.taskId, { status: 'completed', terminalReason: 'reconciled' });
  await tick();
  await tick();
  const after = getBackgroundTask(task.taskId);
  assert.equal(enqueued.length, 1, 'reconcile re-fired the completion once on the terminal task');
  assert.equal(after.notifiedWithBody, true, 'reconcile retry marks the body delivered');
});

test.after(() => { setBackgroundTaskEnqueueFallback(null); });
