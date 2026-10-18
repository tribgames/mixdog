import assert from 'node:assert/strict';
import test from 'node:test';
import { createSendFlow } from './send-flow.mjs';

test('busy canonical sends enqueue a message without starting an admission job', async () => {
  const messages = [];
  const api = createSendFlow({
    mgr: {},
    canUseSessionSurface: () => true,
    sessionSurface: {
      enqueueTurn: async (message) => {
        messages.push(message);
        return { queueDepth: 1 };
      },
    },
    registry: { tagForSession: () => 'worker' },
    views: { isSessionBusy: () => true },
    spawnFlow: { startJob: () => assert.fail('busy send must not acquire an execution slot') },
  });
  const session = { id: 'child', agent: 'worker' };
  const result = await api.dispatchToExistingSession({
    session,
    sessionId: 'child',
    prompt: 'additional instruction',
    args: { context: 'context' },
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { session, prompt: 'additional instruction', context: 'context' });
  assert.match(result, /queued/i);
});

test('a cancelled send ends its worker row as cancelled, not error', async () => {
  const upserts = [];
  let run;
  const session = { id: 'child', agent: 'worker' };
  const api = createSendFlow({
    mgr: {
      getSession: () => session,
      askSession: async () => {
        throw new Error('aborted');
      },
    },
    canUseSessionSurface: () => false,
    registry: {
      tagForSession: () => 'worker',
      upsertWorkerSessionDeferred: (_s, _t, row) => upserts.push(row),
      scheduleReap() {},
    },
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
  await api.dispatchToExistingSession({ session, sessionId: 'child', prompt: 'p', args: {} });
  await assert.rejects(run({}, null), /aborted/);
  await assert.rejects(run({ status: 'cancelled' }, null), /aborted/);
  assert.equal(upserts.at(-3).status, 'error');
  assert.equal(upserts.at(-1).status, 'cancelled');
});

test('a send records its own task id on the worker row while it runs', async () => {
  const upserts = [];
  let run;
  const session = { id: 'child', agent: 'worker' };
  const api = createSendFlow({
    mgr: { getSession: () => session, askSession: async () => ({ content: 'done' }) },
    canUseSessionSurface: () => false,
    registry: {
      tagForSession: () => 'worker',
      upsertWorkerSessionDeferred: (_s, _t, row) => upserts.push(row),
      scheduleReap() {},
    },
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
  await api.dispatchToExistingSession({ session, sessionId: 'child', prompt: 'p', args: {} });
  await run({ taskId: 'task_agent_send_1p' }, null);
  assert.equal(upserts[0].status, 'running');
  assert.equal(upserts[0].task_id, 'task_agent_send_1p');
});

test('a send arms the watchdog with the agent definition and provider first-byte window', async () => {
  const requested = [];
  const policies = [];
  let run;
  const session = { id: 'child', agent: 'art-director', provider: 'antigravity-oauth', model: 'gemini-4-argon' };
  const api = createSendFlow({
    mgr: { getSession: () => session, askSession: async () => ({ content: 'done' }) },
    canUseSessionSurface: () => false,
    registry: { tagForSession: () => 'art', upsertWorkerSessionDeferred() {}, scheduleReap() {} },
    views: { isSessionBusy: () => false, renderJob: () => ({ status: 'running' }) },
    spawnFlow: {
      agentWatchdogOverrides: (target) => {
        requested.push(target);
        return { firstResponseTimeoutMs: 900_000, providerFirstByteTimeoutMs: 466_000 };
      },
      startProgressIdleWatchdog: (_id, policy) => {
        policies.push(policy);
        return { stop() {} };
      },
      turnStartStamper: () => () => {},
      progressStamper: () => () => {},
      workerNotifyFn: () => () => {},
      startJob: (_kind, _meta, fn) => {
        run = fn;
        return {};
      },
    },
  });
  await api.dispatchToExistingSession({ session, sessionId: 'child', prompt: 'p', args: {} });
  await run({}, null);
  assert.deepEqual(requested, [{ agent: 'art-director', provider: 'antigravity-oauth', model: 'gemini-4-argon' }]);
  assert.equal(policies[0].firstTransportMs, 900_000);
});

test('a worker that became idle before enqueue uses the normal admitted continuation', async () => {
  let started = 0;
  const api = createSendFlow({
    mgr: {},
    canUseSessionSurface: () => true,
    sessionSurface: { enqueueTurn: async () => null },
    registry: { tagForSession: () => 'worker' },
    views: { isSessionBusy: () => true, renderJob: () => ({ status: 'running' }) },
    spawnFlow: {
      startJob: () => {
        started += 1;
        return {};
      },
    },
  });
  await api.dispatchToExistingSession({
    session: { id: 'child', agent: 'worker' },
    sessionId: 'child',
    prompt: 'continue',
    args: {},
  });
  assert.equal(started, 1);
});
