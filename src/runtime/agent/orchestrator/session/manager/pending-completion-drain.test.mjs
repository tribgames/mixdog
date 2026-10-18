// Regression: the canonical completion envelopes every producer queues
// (markCompletionEntry) must reach the model-facing drain. They all match the
// display-only isInternalRuntimeNotificationText predicate, which once dropped
// them without claiming/acking, so sub-agent sessions and headless owners
// never saw their completions.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-completion-drain-'));
mkdirSync(root, { recursive: true });
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const {
  _dropPendingMessageState,
  drainPendingMessages,
  enqueuePendingMessage,
  finalizePendingMessageDelivery,
  hydratePendingMessages,
  markCompletionEntry,
  settlePendingMessageWrites,
} = await import('./pending-messages.mjs');
const { renderAgentCompletionEnvelope, renderShellCompletionEnvelope } = await import(
  '../../../../../runtime/shared/task-notification-envelope.mjs'
);
const { isInternalRuntimeNotificationText } = await import('../../../../../runtime/shared/tool-execution-contract.mjs');
const { createNotify } = await import('../../../../../session-runtime/services/agent-tool/notify.mjs');

async function cleanup(sessionId) {
  _dropPendingMessageState(sessionId);
  await settlePendingMessageWrites({ timeoutMs: 4000 });
}

test('queued canonical agent and shell completion envelopes drain exactly once', async () => {
  const sessionId = `sess_completion_drain_${process.pid}`;
  const agent = renderAgentCompletionEnvelope({
    id: 'task_agent_drain',
    tag: 'review',
    status: 'completed',
    result: 'ok',
  });
  const shell = renderShellCompletionEnvelope({
    jobId: 'job_shell_drain',
    status: 'completed',
    exitCode: 0,
    result: 'done',
  });
  assert.equal(isInternalRuntimeNotificationText(agent), true, 'precondition: the display predicate matches');
  assert.equal(isInternalRuntimeNotificationText(shell), true, 'precondition: the display predicate matches');
  try {
    assert.ok(enqueuePendingMessage(sessionId, markCompletionEntry(agent)) > 0);
    assert.ok(enqueuePendingMessage(sessionId, markCompletionEntry(shell)) > 0);
    const drained = drainPendingMessages(sessionId);
    assert.deepEqual(
      drained.map((entry) => entry.text),
      [agent, shell]
    );
    assert.ok(drained.every((entry) => entry.mode === 'task-notification'));
    assert.deepEqual(drainPendingMessages(sessionId), [], 'a second drain finds nothing');
    await finalizePendingMessageDelivery({ id: sessionId }, drained, Promise.resolve(), () => {});
    assert.deepEqual(drainPendingMessages(sessionId), [], 'an acked completion never returns');
  } finally {
    await cleanup(sessionId);
  }
});

test('an undelivered completion survives a restart and is delivered once', async () => {
  const sessionId = `sess_completion_restart_${process.pid}`;
  const failed = renderAgentCompletionEnvelope({
    id: 'task_agent_restart',
    tag: 'mockup',
    status: 'failed',
    result: 'process restart',
  });
  try {
    assert.ok(enqueuePendingMessage(sessionId, markCompletionEntry(failed, { executionId: 'task_agent_restart' })) > 0);
    await settlePendingMessageWrites({ timeoutMs: 4000 });
    // The process dies: memory is gone, the spool row stays.
    _dropPendingMessageState(sessionId, { clearPersisted: false });
    await settlePendingMessageWrites({ timeoutMs: 4000 });

    assert.equal(await hydratePendingMessages(sessionId), 1);
    const drained = drainPendingMessages(sessionId);
    assert.deepEqual(
      drained.map((entry) => entry.text),
      [failed]
    );
    await finalizePendingMessageDelivery({ id: sessionId }, drained, Promise.resolve(), () => {});
    await settlePendingMessageWrites({ timeoutMs: 4000 });
    assert.equal(await hydratePendingMessages(sessionId), 0, 'an acked completion is gone for good');
    assert.deepEqual(drainPendingMessages(sessionId), []);
  } finally {
    await cleanup(sessionId);
  }
});

test('a Subagent background shell completion reaches the worker session drain', async () => {
  const workerId = `sess_worker_completion_${process.pid}`;
  const shell = renderShellCompletionEnvelope({
    jobId: 'job_worker_shell',
    status: 'completed',
    exitCode: 0,
    result: 'built',
  });
  const { workerNotifyFn } = createNotify({ enqueuePendingMessage }, { notifySessionCompletion: () => true });
  try {
    const delivered = workerNotifyFn(workerId)(shell, {
      type: 'shell_task_result',
      execution_surface: 'shell',
      execution_id: 'job_worker_shell',
      status: 'completed',
    });
    assert.equal(delivered, true);
    const drained = drainPendingMessages(workerId);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].text, shell);
    assert.equal(drained[0].execution?.id, 'job_worker_shell');
    assert.deepEqual(drainPendingMessages(workerId), []);
  } finally {
    await cleanup(workerId);
  }
});
