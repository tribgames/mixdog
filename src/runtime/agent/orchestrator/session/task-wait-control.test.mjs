import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeTaskWaitCountForSession,
  beginInterruptibleTaskWait,
  interruptTaskWaitForSession,
} from './task-wait-control.mjs';
import {
  cancelBackgroundTask,
  getBackgroundTask,
  registerBackgroundTask,
} from '../../../shared/background-tasks.mjs';
import { executeTaskTool } from '../tools/builtin/task-tool.mjs';

test('user input interrupts only task waits in its session', () => {
  const first = beginInterruptibleTaskWait('sess_wait_1');
  const second = beginInterruptibleTaskWait('sess_wait_1');
  const other = beginInterruptibleTaskWait('sess_wait_2');

  assert.equal(activeTaskWaitCountForSession('sess_wait_1'), 2);
  assert.equal(interruptTaskWaitForSession('sess_wait_1'), 2);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(first.interruptedByUser, true);
  assert.equal(second.interruptedByUser, true);
  assert.equal(other.signal.aborted, false);

  first.dispose();
  second.dispose();
  other.dispose();
  assert.equal(activeTaskWaitCountForSession('sess_wait_1'), 0);
});

test('turn cancellation propagates without masquerading as user input', () => {
  const parent = new AbortController();
  const wait = beginInterruptibleTaskWait('sess_parent_abort', parent.signal);

  parent.abort('turn-cancelled');
  assert.equal(wait.signal.aborted, true);
  assert.equal(wait.interruptedByUser, false);

  wait.dispose();
});

test('task wait returns on user input without cancelling the background task', async () => {
  const sessionId = 'sess_task_wait_integration';
  const taskId = 'task_shell_wait_integration';
  const task = registerBackgroundTask({
    taskId,
    surface: 'shell',
    operation: 'run',
    context: {
      callerSessionId: sessionId,
      routingSessionId: sessionId,
    },
  });
  task.promise = new Promise(() => {});

  const interruptTimer = setTimeout(
    () => interruptTaskWaitForSession(sessionId),
    20,
  );
  const startedAt = Date.now();
  try {
    const result = await executeTaskTool(
      { action: 'wait', task_id: taskId, timeout_ms: 10_000 },
      { sessionId, callerSessionId: sessionId, routingSessionId: sessionId },
    );

    assert.ok(Date.now() - startedAt < 1_000, 'wait should return before its ceiling');
    assert.match(result, /Wait interrupted by new user input/);
    assert.equal(getBackgroundTask(taskId)?.status, 'running');
  } finally {
    clearTimeout(interruptTimer);
    cancelBackgroundTask(taskId, 'test cleanup');
  }
});
