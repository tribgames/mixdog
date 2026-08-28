import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBackgroundTasks } from '../../runtime/shared/background-tasks.mjs';
import { createSpawnFlow } from './spawn-flow.mjs';

test('agent job lifecycle publishes status immediately and after terminal settlement', async () => {
  let publications = 0;
  const flow = createSpawnFlow({
    mgr: { closeSession() {} },
    notifyStatusChange: () => { publications += 1; },
  });

  const job = flow.startJob(
    'spawn',
    { tag: 'status-test' },
    async () => ({ content: 'done' }),
    { callerSessionId: 'lead-test', clientHostPid: process.pid },
  );

  assert.equal(job.status, 'running');
  assert.equal(publications, 1);
  await job.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.status, 'completed');
  assert.ok(publications >= 2);
  cleanupBackgroundTasks({ surface: 'agent', force: true });
});

test('agent job completion uses immutable caller owner and never invokes stale notify context', async () => {
  const deliveries = [];
  let staleCalls = 0;
  const flow = createSpawnFlow({
    mgr: { closeSession() {} },
    notifySessionCompletion(sessionId, text, meta) {
      deliveries.push({ sessionId, text, meta });
      return true;
    },
  });

  const job = flow.startJob(
    'spawn',
    { tag: 'owner-test' },
    async () => ({ content: 'owner handoff' }),
    {
      callerSessionId: 'lead-owner',
      routingSessionId: 'wrong-lead',
      clientHostPid: process.pid,
      notifyFn() {
        staleCalls += 1;
        return true;
      },
    },
  );

  await job.promise;
  assert.equal(staleCalls, 0);
  assert.ok(deliveries.length >= 1);
  assert.ok(deliveries.every((entry) => entry.sessionId === 'lead-owner'));
  assert.ok(deliveries.every((entry) => entry.meta.caller_session_id === 'lead-owner'));
  assert.match(deliveries.at(-1).text, /owner handoff/);
  cleanupBackgroundTasks({ surface: 'agent', force: true });
});

test('a user-cancelled Agent turn settles the worker row as cancelled, not error', async () => {
  const updates = [];
  const flow = createSpawnFlow({
    mgr: {
      getSession: () => ({ messages: [] }),
    },
    upsertWorkerSessionDeferred(_session, _tag, patch) {
      updates.push(patch);
    },
    emitSubagentEvent() {},
    scheduleReap() {},
    createTurnReviewCollector: () => ({
      onToolResult() {},
      complete() {},
    }),
    sessionSurface: {
      canonical: true,
      canRun: () => true,
      async runTurn() {
        throw new Error('cancelled by agent close');
      },
    },
  });
  const job = { taskId: 'task-agent-cancelled', status: 'cancelled' };

  await assert.rejects(flow.runSpawn({
    args: {},
    tag: 'cancelled-worker',
    session: { id: 'sess_cancelled_worker' },
    agent: 'worker',
    preset: { provider: 'test-provider', model: 'test-model' },
    presetName: 'worker-route',
    workerCwd: 'C:\\Project\\tree',
    prompt: 'cancel me',
    watchdogPolicy: null,
  }, { callerSessionId: 'sess_lead' }, job), /cancelled by agent close/);

  assert.equal(updates.at(-1).status, 'cancelled');
  assert.equal(updates.at(-1).stage, 'cancelled');
});
