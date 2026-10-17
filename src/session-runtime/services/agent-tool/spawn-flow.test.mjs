import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { cleanupBackgroundTasks } from '../../../runtime/shared/background-tasks.mjs';

// Install synthetic boundaries before loading the flow's transitive imports:
// these lifecycle tests must not prepare real agents or access user stores.
mock.module('../../../runtime/agent/orchestrator/agent-runtime/session-builder.mjs', {
  namedExports: {
    prepareAgentSession: () => {
      throw new Error('unexpected real session preparation');
    },
  },
});
mock.module('../../../runtime/agent/orchestrator/providers/registry.mjs', {
  namedExports: { getProvider: () => undefined },
});
mock.module('../../../runtime/agent/orchestrator/session/store.mjs', {
  namedExports: {
    loadSession: () => null,
    readSessionLifecycleStateFromDisk: () => ({ state: 'absent', generation: 0 }),
    saveSessionAsync: async () => {},
    registerSessionPurgeHook: () => () => {},
  },
});
mock.module('../../../vendor/statusline/src/gateway/session-routes.mjs', {
  namedExports: {
    clearGatewaySessionRoute: () => true,
    writeGatewaySessionRoutes: () => true,
  },
});
const { createSpawnFlow } = await import('./spawn-flow.mjs');
const { createCloseFlow } = await import('./close-flow.mjs');
const { parseTaskNotification } = await import('../../../runtime/shared/task-notification-envelope.mjs');
const { createAgentTree } = await import('../../../standalone/session-service/agent-tree.mjs');

test('agent job lifecycle publishes status immediately and after terminal settlement', async () => {
  let publications = 0;
  const flow = createSpawnFlow({
    mgr: { closeSession() {} },
    notifyStatusChange: () => {
      publications += 1;
    },
  });

  const job = flow.startJob('spawn', { tag: 'status-test' }, async () => ({ content: 'done' }), {
    callerSessionId: 'lead-test',
    clientHostPid: process.pid,
  });

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

  const job = flow.startJob('spawn', { tag: 'owner-test' }, async () => ({ content: 'owner handoff' }), {
    callerSessionId: 'lead-owner',
    routingSessionId: 'wrong-lead',
    clientHostPid: process.pid,
    notifyFn() {
      staleCalls += 1;
      return true;
    },
  });

  await job.promise;
  assert.equal(staleCalls, 0);
  assert.ok(deliveries.length >= 1);
  assert.ok(deliveries.every((entry) => entry.sessionId === 'lead-owner'));
  assert.ok(deliveries.every((entry) => entry.meta.caller_session_id === 'lead-owner'));
  assert.match(deliveries.at(-1).text, /owner handoff/);
  cleanupBackgroundTasks({ surface: 'agent', force: true });
});

test('the progress stamp keeps a working stage beside status running, whatever phase the runtime reads', () => {
  const updates = [];
  const flow = createSpawnFlow({
    mgr: {},
    upsertWorkerSessionDeferred(_session, _tag, patch) {
      updates.push(patch);
    },
    sessionSurface: { canonical: true },
  });
  const stamp = flow.progressStamper({ id: 'sess_progress' }, 'progress-worker');
  for (const stage of ['idle', 'done', 'error', null]) stamp({ messages: 2, stage });
  for (const stage of ['connecting', 'requesting', 'streaming', 'tool_running', 'resource_wait']) stamp({ stage });
  assert.deepEqual(
    updates.map((patch) => [patch.status, patch.stage]),
    [
      ['running', 'running'],
      ['running', 'running'],
      ['running', 'running'],
      ['running', 'running'],
      ['running', 'connecting'],
      ['running', 'requesting'],
      ['running', 'streaming'],
      ['running', 'tool_running'],
      ['running', 'resource_wait'],
    ]
  );
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

  await assert.rejects(
    flow.runSpawn(
      {
        args: {},
        tag: 'cancelled-worker',
        session: { id: 'sess_cancelled_worker' },
        agent: 'worker',
        preset: { provider: 'test-provider', model: 'test-model' },
        presetName: 'worker-route',
        workerCwd: 'C:\\Project\\tree',
        prompt: 'cancel me',
        watchdogPolicy: null,
      },
      { callerSessionId: 'sess_lead' },
      job
    ),
    /cancelled by agent close/
  );

  assert.equal(updates.at(-1).status, 'cancelled');
  assert.equal(updates.at(-1).stage, 'cancelled');
});

// A running worker whose turn appends `partial` (if any) and then blocks until
// its session is closed, owned by a Lead that records every delivery.
async function closeRunningWorker(partial) {
  const deliveries = [];
  const closures = [];
  const session = { id: 'sess_close_worker', messages: [{ role: 'user', content: 'earlier turn' }] };
  let rejectTurn = null;
  let turnStarted;
  const started = new Promise((resolve) => {
    turnStarted = resolve;
  });
  const mgr = {
    getSession: () => session,
    askSession: () =>
      new Promise((_resolve, reject) => {
        if (partial) session.messages.push({ role: 'assistant', content: partial });
        rejectTurn = reject;
        turnStarted();
      }),
    closeSession(...args) {
      closures.push(args);
      rejectTurn?.(new Error('Session closed: closeSession'));
      return true;
    },
  };
  const flow = createSpawnFlow({
    mgr,
    notifySessionCompletion(sessionId, text) {
      deliveries.push({ sessionId, text });
      return true;
    },
    upsertWorkerSessionDeferred() {},
    emitSubagentEvent() {},
    scheduleReap() {},
    createTurnReviewCollector: () => ({ onToolResult() {}, complete() {} }),
  });
  const prepared = {
    args: {},
    tag: 'close-worker',
    session,
    agent: 'worker',
    preset: { provider: 'test-provider', model: 'test-model' },
    presetName: 'worker-route',
    workerCwd: 'C:\\Project\\tree',
    prompt: 'work',
    watchdogPolicy: null,
  };
  const lead = { callerSessionId: 'sess_close_lead', clientHostPid: process.pid };
  const job = flow.startJob(
    'spawn',
    { tag: 'close-worker', sessionId: session.id },
    (task, ownerNotifyContext) => flow.runSpawn(prepared, ownerNotifyContext, task),
    lead
  );
  await started;
  const closeFlow = createCloseFlow({
    mgr,
    registry: {
      tags: new Map(),
      tagAgents: new Map(),
      tagCwds: new Map(),
      refreshTagsFromSessions() {},
      wantsSessionScan: () => false,
      resolveTag: () => session.id,
      getLiveSession: () => ({ agent: 'worker' }),
      cancelReap() {},
      tagForSession: () => 'close-worker',
      forgetTerminalSession() {},
      removeWorkerRow() {},
    },
    views: {},
  });
  const closed = await closeFlow.close({ tag: 'close-worker' }, lead);
  await job.promise;
  await new Promise((resolve) => setImmediate(resolve));
  return { closed, deliveries, job, closures };
}

test('agent close of a running agent notifies the owner once, as cancelled, with the partial output', async () => {
  try {
    const { closed, deliveries, job, closures } = await closeRunningWorker('half of the review');
    assert.ok(closures.length >= 2, 'both task cancellation and explicit runtime close are exercised');
    assert.ok(closures.every(([, , options]) => options?.tombstone === false));
    assert.equal(closed.closed, true);
    assert.equal(job.status, 'cancelled');
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].sessionId, 'sess_close_lead');
    const parsed = parseTaskNotification(deliveries[0].text);
    assert.equal(parsed.status, 'cancelled');
    assert.equal(parsed.result, 'half of the review');
    assert.match(parsed.summary, /was cancelled \(cancelled by agent close\)/);
  } finally {
    cleanupBackgroundTasks({ surface: 'agent', force: true });
  }
});

test('agent-tree cancel of a running agent reports its own task to the owner once, as cancelled with partial output', async () => {
  const deliveries = [];
  const pendingTurns = [];
  const runtimes = new Map();
  const runtimeFor = (id) => {
    if (!runtimes.has(id)) {
      const runtime = {
        messages: [],
        readModelMessages(start) {
          return { messageCount: runtime.messages.length, messages: runtime.messages.slice(start) };
        },
        getState: () => ({ items: [] }),
        submitAndWait(prompt) {
          runtime.messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: 'partial review' });
          return new Promise((resolve) => pendingTurns.push(resolve));
        },
        async closeCanonicalSession() {
          // Like the real close: the session (and its transcript) is cleared
          // before the running turn settles as cancelled.
          runtime.messages = [];
          for (const resolve of pendingTurns.splice(0)) resolve({ status: 'cancelled' });
          return true;
        },
      };
      runtimes.set(id, runtime);
    }
    return runtimes.get(id);
  };
  let nextId = 1;
  const tree = createAgentTree({
    listSessions: async () => [],
    readStoredSession: async () => null,
    sessionOwner: (id) => (runtimes.has(id) ? { runtime: runtimeFor(id) } : null),
    stateBusy: () => false,
    entryForSession: async (id) => ({ runtime: runtimeFor(id) }),
    retainUnwatched() {},
    createSession: async () => ({ sessionId: `tree-child-${nextId++}` }),
  });
  const { session } = await tree.createAgentChild({
    spec: {
      parentSessionId: 'sess_tree_lead',
      agent: 'reviewer',
      preset: { provider: 'openai', model: 'gpt-5', id: 'review' },
      cwd: 'C:/work',
    },
  });
  const flow = createSpawnFlow({
    mgr: tree.agentManager,
    sessionSurface: tree.agentSurface,
    notifySessionCompletion(sessionId, text) {
      deliveries.push({ sessionId, text });
      return true;
    },
    upsertWorkerSessionDeferred() {},
    emitSubagentEvent() {},
    scheduleReap() {},
    createTurnReviewCollector: () => ({ onToolResult() {}, complete() {} }),
  });
  const prepared = {
    args: {},
    tag: 'tree-worker',
    session,
    agent: 'reviewer',
    preset: { provider: 'openai', model: 'gpt-5' },
    presetName: 'review',
    workerCwd: 'C:/work',
    prompt: 'review it',
    watchdogPolicy: null,
  };
  try {
    const job = flow.startJob(
      'spawn',
      { tag: 'tree-worker', sessionId: session.id },
      (task, ownerNotifyContext) => flow.runSpawn(prepared, ownerNotifyContext, task),
      { callerSessionId: 'sess_tree_lead', clientHostPid: process.pid }
    );
    while (pendingTurns.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await tree.cancelAgentTree(session.id, 'agent session cancelled'), true);
    await job.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(job.status, 'cancelled');
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].sessionId, 'sess_tree_lead');
    const parsed = parseTaskNotification(deliveries[0].text);
    assert.equal(parsed.status, 'cancelled');
    assert.equal(parsed.result, 'partial review');
    assert.match(parsed.summary, /was cancelled \(agent session cancelled\)/);
  } finally {
    cleanupBackgroundTasks({ surface: 'agent', force: true });
  }
});

test('agent close of a running agent without output sends the header-only cancelled notification', async () => {
  try {
    const { deliveries, job } = await closeRunningWorker('');
    assert.equal(job.status, 'cancelled');
    assert.equal(deliveries.length, 1);
    const parsed = parseTaskNotification(deliveries[0].text);
    assert.equal(parsed.status, 'cancelled');
    assert.equal(parsed.result, '');
    assert.match(parsed.summary, /\(cancelled by agent close\)/);
  } finally {
    cleanupBackgroundTasks({ surface: 'agent', force: true });
  }
});
