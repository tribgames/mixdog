import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cleanupBackgroundTasks,
  completeBackgroundTask,
  getBackgroundTask,
  registerBackgroundTask,
  renderBackgroundTask,
  renderBackgroundTaskNotification,
} from './background-tasks.mjs';
import { modelVisibleToolCompletionMessage } from './tool-execution-contract.mjs';
import { executeTaskTool } from '../agent/orchestrator/tools/builtin/task-tool.mjs';
import {
  _dropPendingMessageState,
  drainPendingMessages,
  enqueuePendingMessage,
  markCompletionEntry,
  settlePendingMessageWrites,
} from '../agent/orchestrator/session/manager/pending-messages.mjs';
import { _clearDeliveredCompletions } from '../agent/orchestrator/session/manager/delivered-completions.mjs';
import { parseTaskNotification } from './task-notification-envelope.mjs';

test('task output reports each error once while preserving metadata and verbatim results', () => {
  const body = '  stdout\r\nstderr\n\n';
  const task = {
    taskId: 'job_lossless',
    surface: 'shell',
    operation: 'shell',
    status: 'failed',
    startedAt: '2026-09-21T00:00:00Z',
    finishedAt: '2026-09-21T00:00:01Z',
    error: 'terminated by signal',
    meta: { cwd: '/work', stdout: '/logs/out', stderr: '/logs/err' },
    resultText: body,
  };
  const output = renderBackgroundTask(task, { includeResult: true });
  assert.match(output, /surface: shell\noperation: shell/);
  assert.ok(output.endsWith(body));
  for (const value of [task.taskId, task.startedAt, task.finishedAt, '/work', '/logs/out', '/logs/err'])
    assert.ok(output.includes(value));
  const withoutBody = renderBackgroundTask({ ...task, resultText: '' }, { includeResult: true });
  assert.equal(withoutBody.split(task.error).length - 1, 1);
  assert.match(withoutBody, /status: failed/);
  const distinct = renderBackgroundTask({ ...task, operation: 'test' });
  assert.match(distinct, /surface: shell\noperation: test/);
});

test('agent notifications bypass the card renderer and retain the entire final message', () => {
  const result = `  final message\n${'full result '.repeat(4_000)}\n`;
  const notifications = [];
  const task = registerBackgroundTask({
    surface: 'agent',
    label: 'tidy-skill',
    meta: { tag: 'tidy-skill', provider: 'provider', model: 'model' },
    renderResult: () => 'card-only result metadata',
    context: { notifyFn: (text) => notifications.push(text) },
  });
  try {
    completeBackgroundTask(task.taskId, { result: { content: result } });
    assert.equal(notifications.length, 1);
    assert.equal(parseTaskNotification(notifications[0]).result, result);
    assert.equal(notifications[0], renderBackgroundTaskNotification(task));
    assert.doesNotMatch(notifications[0], /card-only|provider:|model:|<usage>/);
    assert.match(
      renderBackgroundTask(task, { includeResult: true }),
      /provider: provider[\s\S]*card-only result metadata/
    );
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('explicit resultText is not capped at the previous 32k task-record limit', () => {
  const task = registerBackgroundTask({ surface: 'agent' });
  const resultText = 'x'.repeat(40_001);
  try {
    completeBackgroundTask(task.taskId, { resultText, notify: false });
    assert.equal(task.resultText, resultText);
    assert.equal(parseTaskNotification(renderBackgroundTaskNotification(task)).result, resultText);
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('terminal task read ACKs queued and racing completion notifications', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-task-read-ack-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const sessionId = `sess_task_read_ack_${process.pid}`;
  const taskId = `task_read_ack_${process.pid}`;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const task = registerBackgroundTask({
      taskId,
      surface: 'shell',
      operation: 'shell',
      context: { callerSessionId: sessionId },
    });
    const instruction = `Async shell task ${taskId} (completed, exit 0) finished.`;
    completeBackgroundTask(taskId, {
      status: 'completed',
      resultText: 'command output',
      resultType: 'shell_task_result',
      instruction,
      notify: false,
    });
    const completionText = renderBackgroundTask(task, { includeResult: true });
    const visible = modelVisibleToolCompletionMessage(completionText, {
      type: 'shell_task_result',
      execution_surface: 'shell',
      execution_id: taskId,
      status: 'completed',
      instruction,
    });
    const entry = markCompletionEntry(visible, { executionId: taskId });
    assert.ok(enqueuePendingMessage(sessionId, entry) > 0);
    await settlePendingMessageWrites({ throwOnTimeout: true });

    assert.match(await executeTaskTool({ action: 'read', task_id: taskId }, { sessionId }), /status: completed/);
    assert.equal(getBackgroundTask(taskId).completionAcknowledged, true);

    // Covers both orderings: already queued before the read, and a fallback
    // enqueue that races in after the read ACK.
    assert.ok(enqueuePendingMessage(sessionId, entry) > 0);
    assert.deepEqual(drainPendingMessages(sessionId), []);
    await settlePendingMessageWrites({ throwOnTimeout: true });
  } finally {
    _dropPendingMessageState(sessionId);
    await settlePendingMessageWrites({ throwOnTimeout: true }).catch(() => {});
    cleanupBackgroundTasks({ force: true });
    _clearDeliveredCompletions();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});
