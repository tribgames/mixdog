import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeTaskWaitCountForSession,
  beginInterruptibleTaskWait,
  interruptTaskWaitForSession,
  registerTaskWaitSteeringCheck,
} from './task-wait-control.mjs';
import { cancelBackgroundTask, getBackgroundTask, registerBackgroundTask } from '../../../shared/background-tasks.mjs';
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

test('wait entry checks live steering only in its session and only during its owning turn', () => {
  const sessionId = 'sess_pending_steering';
  let pending = true;
  const stop = registerTaskWaitSteeringCheck((id) => id === sessionId && pending);
  const waits = [];
  const begin = (id = sessionId, signal = null) => {
    const wait = beginInterruptibleTaskWait(id, signal);
    waits.push(wait);
    return wait;
  };
  try {
    assert.equal(interruptTaskWaitForSession(sessionId), 0, 'input arrived before any waiter');
    assert.equal(begin().interruptedByUser, true);
    assert.equal(begin().signal.aborted, true, 'parallel waits must also skip pending steering');
    assert.equal(begin('sess_other_steering').signal.aborted, false);

    const parent = new AbortController();
    parent.abort('turn-cancelled');
    const cancelled = begin(sessionId, parent.signal);
    assert.equal(cancelled.signal.reason, 'turn-cancelled');
    assert.equal(cancelled.interruptedByUser, false);

    pending = false;
    assert.equal(begin().signal.aborted, false, 'consumed or reclaimed input must not leave a stale wake');
    pending = true;
    stop();
    assert.equal(begin().signal.aborted, false, 'a closed turn must release its queue check');
  } finally {
    stop();
    for (const wait of waits) wait.dispose();
  }
});

test('task wait immediately returns for input queued before wait entry without cancelling the task', async () => {
  const sessionId = 'sess_task_wait_prequeued';
  const taskId = 'task_shell_wait_prequeued';
  const task = registerBackgroundTask({
    taskId,
    surface: 'shell',
    operation: 'run',
    context: { callerSessionId: sessionId, routingSessionId: sessionId },
  });
  task.promise = new Promise(() => {});
  const stop = registerTaskWaitSteeringCheck((id) => id === sessionId);
  const startedAt = Date.now();
  // Keep the test alive if a regression incorrectly enters the passive wait.
  const ceiling = setTimeout(() => {}, 11_000);
  try {
    assert.equal(interruptTaskWaitForSession(sessionId), 0);
    const result = await executeTaskTool(
      { action: 'wait', task_id: taskId, timeout_ms: 10_000 },
      { sessionId, callerSessionId: sessionId, routingSessionId: sessionId }
    );
    assert.ok(Date.now() - startedAt < 1_000, 'prequeued input should release wait immediately');
    assert.match(result, /Wait interrupted by new user input/);
    assert.equal(getBackgroundTask(taskId)?.status, 'running');
    assert.equal(activeTaskWaitCountForSession(sessionId), 0);
  } finally {
    clearTimeout(ceiling);
    stop();
    cancelBackgroundTask(taskId, 'test cleanup');
  }
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

  const interruptTimer = setTimeout(() => interruptTaskWaitForSession(sessionId), 20);
  const startedAt = Date.now();
  try {
    const result = await executeTaskTool(
      { action: 'wait', task_id: taskId, timeout_ms: 10_000 },
      { sessionId, callerSessionId: sessionId, routingSessionId: sessionId }
    );

    assert.ok(Date.now() - startedAt < 1_000, 'wait should return before its ceiling');
    assert.match(result, /Wait interrupted by new user input/);
    assert.equal(getBackgroundTask(taskId)?.status, 'running');
  } finally {
    clearTimeout(interruptTimer);
    cancelBackgroundTask(taskId, 'test cleanup');
  }
});
