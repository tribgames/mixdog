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
} from './background-tasks.mjs';
import { modelVisibleToolCompletionMessage } from './tool-execution-contract.mjs';
import { executeTaskTool } from '../agent/orchestrator/tools/builtin/task-tool.mjs';
import {
  _dropPendingMessageState,
  _settlePendingMessageWrites,
  drainPendingMessages,
  enqueuePendingMessage,
  markCompletionEntry,
} from '../agent/orchestrator/session/manager/pending-messages.mjs';
import { _clearDeliveredCompletions } from '../agent/orchestrator/session/manager/delivered-completions.mjs';

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
    await _settlePendingMessageWrites();

    assert.match(
      await executeTaskTool({ action: 'read', task_id: taskId }, { sessionId }),
      /status: completed/,
    );
    assert.equal(getBackgroundTask(taskId).completionAcknowledged, true);

    // Covers both orderings: already queued before the read, and a fallback
    // enqueue that races in after the read ACK.
    assert.ok(enqueuePendingMessage(sessionId, entry) > 0);
    assert.deepEqual(drainPendingMessages(sessionId), []);
    await _settlePendingMessageWrites();
  } finally {
    _dropPendingMessageState(sessionId);
    await _settlePendingMessageWrites().catch(() => {});
    cleanupBackgroundTasks({ force: true });
    _clearDeliveredCompletions();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});
