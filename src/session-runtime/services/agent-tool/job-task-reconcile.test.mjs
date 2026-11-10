import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBackgroundTask,
  registerBackgroundTask,
  renderBackgroundTaskNotification,
} from '../../../runtime/shared/background-tasks.mjs';
import { reconcileJobFinally, reconcileJobWatchdogPartial, WATCHDOG_STOP_ERROR } from './job-task-reconcile.mjs';

test('a watchdog stop that recovered partial output reaches the owner as a failure, not a completion', () => {
  const task = registerBackgroundTask({ surface: 'agent', operation: 'spawn', label: 'worker' });
  const value = { tag: 'worker', content: 'partial findings', stallAbort: true };
  const job = { taskId: task.taskId, _terminalResultValue: value };
  reconcileJobWatchdogPartial(job, value);
  // The finally net that follows cannot turn it back into a completion.
  reconcileJobFinally(job, 'idle');
  const settled = getBackgroundTask(task.taskId);
  assert.equal(settled.status, 'failed');
  assert.equal(settled.terminalReason, 'agent-watchdog-partial');
  assert.match(settled.error, /stalled/);
  assert.match(WATCHDOG_STOP_ERROR, /^stalled:/);
  // The owner's notification says failed and still carries the partial output.
  const notice = renderBackgroundTaskNotification(settled);
  assert.match(notice, /failed/);
  assert.match(notice, /partial findings/);
});
