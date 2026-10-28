import assert from 'node:assert/strict';
import test from 'node:test';
import { createSendFlow } from './send-flow.mjs';
import { createSpawnRunner } from './spawn-flow/spawn-run.mjs';
import { AgentStallAbortError } from '../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { providerTimeoutError } from '../../../runtime/agent/orchestrator/stall-policy.mjs';
import { armTurnShellReap } from '../../../runtime/agent/orchestrator/session/manager/turn-reap.mjs';
import { registerBackgroundTask } from '../../../runtime/shared/background-tasks.mjs';

// A stalled agent with no partial text rethrows the stall error; the shell jobs
// its timeout reap stopped must still be named in that error's text.
function stoppedJob(sessionId, taskId) {
  registerBackgroundTask({
    taskId,
    surface: 'shell',
    operation: 'shell',
    label: taskId,
    context: { callerSessionId: sessionId, routingSessionId: sessionId },
    cancel() {},
  });
  armTurnShellReap(sessionId, { askStartedAt: Date.now() - 1_000 });
}
const stall = () => new AgentStallAbortError('agent task stale (1ms without progress)');

test('a send ended by a terminal provider timeout names the stopped jobs in its error', async () => {
  const session = { id: 'timeout_send', agent: 'worker', messages: [] };
  let run;
  const api = createSendFlow({
    mgr: {
      getSession: () => session,
      askSession: async () => {
        stoppedJob(session.id, 'task_timeout_send_job');
        throw providerTimeoutError('provider', 1);
      },
    },
    canUseSessionSurface: () => false,
    registry: { tagForSession: () => 'worker', upsertWorkerSessionDeferred() {}, scheduleReap() {} },
    views: { isSessionBusy: () => false, renderJob: () => ({ status: 'running' }) },
    spawnFlow: {
      agentWatchdogOverrides: () => ({}),
      startProgressIdleWatchdog: () => ({ stop() {} }),
      turnStartStamper: () => () => {},
      progressStamper: () => () => {},
      workerNotifyFn: () => () => {},
      startJob: (_kind, _meta, fn) => {
        run = fn;
        return {};
      },
    },
  });
  await api.dispatchToExistingSession({ session, sessionId: session.id, prompt: 'p', args: {} });
  await assert.rejects(run({}, null), /timed out.*\[Stopped its background shell jobs: task_timeout_send_job\.\]/);
});

test('a spawn ended by a terminal provider timeout names the stopped jobs in its error', async () => {
  const session = { id: 'timeout_spawn', agent: 'worker' };
  const runner = createSpawnRunner({
    mgr: { getSession: () => ({ messages: [] }) },
    upsertWorkerSessionDeferred() {},
    emitSubagentEvent() {},
    createTurnReviewCollector: () => ({ onToolResult() {}, complete() {} }),
    sessionSurface: {
      canonical: true,
      canRun: () => true,
      runTurn: async () => {
        stoppedJob(session.id, 'task_timeout_spawn_job');
        throw providerTimeoutError('provider', 1);
      },
    },
  });
  await assert.rejects(
    runner.runSpawn(
      {
        args: {},
        tag: 'timeout_spawn',
        session,
        agent: 'worker',
        preset: { provider: 'test-provider', model: 'test-model' },
        presetName: 'worker-route',
        workerCwd: process.cwd(),
        prompt: 'work',
        watchdogPolicy: null,
      },
      {},
      null
    ),
    /timed out.*\[Stopped its background shell jobs: task_timeout_spawn_job\.\]/
  );
});

test('a send stalled with no partial output names the stopped background shell jobs in its error', async () => {
  const session = { id: 'stalled_send', agent: 'worker', messages: [] };
  let run;
  const api = createSendFlow({
    mgr: {
      getSession: () => session,
      askSession: async () => {
        stoppedJob(session.id, 'task_stalled_send_job');
        throw stall();
      },
    },
    canUseSessionSurface: () => false,
    registry: { tagForSession: () => 'worker', upsertWorkerSessionDeferred() {}, scheduleReap() {} },
    views: { isSessionBusy: () => false, renderJob: () => ({ status: 'running' }) },
    spawnFlow: {
      agentWatchdogOverrides: () => ({}),
      startProgressIdleWatchdog: () => ({ stop() {} }),
      turnStartStamper: () => () => {},
      progressStamper: () => () => {},
      workerNotifyFn: () => () => {},
      startJob: (_kind, _meta, fn) => {
        run = fn;
        return {};
      },
    },
  });
  await api.dispatchToExistingSession({ session, sessionId: session.id, prompt: 'p', args: {} });
  await assert.rejects(run({}, null), /agent task stale.*\[Stopped its background shell jobs: task_stalled_send_job\.\]/);
});

test('a spawn stalled with no partial output names the stopped background shell jobs in its error', async () => {
  const session = { id: 'stalled_spawn', agent: 'worker' };
  const runner = createSpawnRunner({
    mgr: { getSession: () => ({ messages: [] }) },
    upsertWorkerSessionDeferred() {},
    emitSubagentEvent() {},
    createTurnReviewCollector: () => ({ onToolResult() {}, complete() {} }),
    sessionSurface: {
      canonical: true,
      canRun: () => true,
      runTurn: async () => {
        stoppedJob(session.id, 'task_stalled_spawn_job');
        throw stall();
      },
    },
  });
  await assert.rejects(
    runner.runSpawn(
      {
        args: {},
        tag: 'stalled_spawn',
        session,
        agent: 'worker',
        preset: { provider: 'test-provider', model: 'test-model' },
        presetName: 'worker-route',
        workerCwd: process.cwd(),
        prompt: 'work',
        watchdogPolicy: null,
      },
      {},
      null
    ),
    /agent task stale.*\[Stopped its background shell jobs: task_stalled_spawn_job\.\]/
  );
});
