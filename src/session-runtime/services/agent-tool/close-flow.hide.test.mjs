import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import test, { mock } from 'node:test';

import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

mock.module('../../../vendor/statusline/src/gateway/session-routes.mjs', {
  namedExports: { clearGatewaySessionRoute: () => true, writeGatewaySessionRoutes: () => true },
});
const { createTagRegistry } = await import('./tag-registry.mjs');
const { createCloseFlow } = await import('./close-flow.mjs');
const { createSendDispatch } = await import('./execute-send.mjs');
const { createSendFlow } = await import('./send-flow.mjs');
const { registerSessionSidebarHost } = await import('../../../runtime/shared/session-sidebar-host.mjs');
const { listRowFilter } = await import('../../../standalone/daemon-session-control/list-page.mjs');
const { daemonHiddenSessions } = await import('../../../runtime/shared/session-hidden.mjs');
const { sessionPath } = await import('../../../runtime/agent/orchestrator/session/store/session-paths.mjs');
const { completeBackgroundTask, registerBackgroundTask } = await import(
  '../../../runtime/shared/background-tasks.mjs'
);

const OWNER = { callerSessionId: 'lead-a', clientHostPid: 4242 };

function agentSession(id, tag, extra = {}) {
  const now = Date.now() - 60_000;
  return {
    id,
    agentTag: tag,
    ownerSessionId: 'lead-a',
    parentSessionId: 'lead-a',
    agent: 'reviewer',
    cwd: process.cwd(),
    clientHostPid: 4242,
    status: 'idle',
    createdAt: now,
    lastUsedAt: now,
    lastTurnCompletedAt: now,
    closed: false,
    closeProvenance: 1,
    messages: [{ role: 'user', content: 'brief' }],
    ...extra,
  };
}

// A desktop host keeping the archive flags, and the session list as the daemon
// filters it (agents included, archived ones only on request).
function setup(t, sessionList, { desktop = true } = {}) {
  const root = makeTempDirSync('close-hide');
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const sessions = new Map(sessionList.map((session) => [session.id, session]));
  for (const session of sessions.values()) {
    mkdirSync(dirname(sessionPath(session.id)), { recursive: true });
    writeFileSync(sessionPath(session.id), JSON.stringify(session));
  }
  const archived = {};
  const unregister = desktop
    ? registerSessionSidebarHost(
        async (id, change) => {
          if (change.archived === true) archived[id] ??= Date.now();
          else if (change.archived === false) delete archived[id];
        },
        { state: async () => ({ archived }) }
      )
    : () => {};
  const closed = [];
  const failing = new Set();
  const running = new Set();
  const mgr = {
    getSession: (id) => sessions.get(id) || null,
    listSessions: () => [...sessions.values()],
    getSessionRuntime: (id) => (failing.has(id) ? { closeBarrierError: { message: 'barrier did not land' } } : null),
    isSessionTurnInFlight: (id) => running.has(id),
    closeSession: async (id) => {
      if (failing.has(id)) return false;
      closed.push(id);
      return true;
    },
    unloadSessionRuntime: () => {},
    hideSessionFromList: () => {},
  };
  const registry = createTagRegistry({ dataDir: root, cfgMod: { loadConfig: () => ({}) }, mgr });
  const closeFlow = createCloseFlow({ mgr, registry, views: { listJobs: () => [], list: () => [] } });
  t.after(async () => {
    unregister();
    await registry.disposeAsync();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });
  const listed = ({ includeArchived = false } = {}) =>
    [...sessions.values()]
      .filter(
        listRowFilter({ include_agents: true, include_archived: includeArchived }, {
          ...archived,
          ...daemonHiddenSessions(),
        })
      )
      .map((session) => session.id);
  return { registry, closeFlow, mgr, archived, closed, failing, running, sessions, listed, root };
}

const bind = (env, id, tag, status = 'idle') => env.registry.upsertWorkerSession(env.sessions.get(id), tag, { status });

test('closing an agent hides its session from the list and keeps its file', async (t) => {
  const env = setup(t, [agentSession('sess_a1', 'review1')]);
  bind(env, 'sess_a1', 'review1');
  assert.deepEqual(env.listed(), ['sess_a1']);
  const result = await env.closeFlow.close({ tag: 'review1' }, OWNER);
  assert.equal(result.closed, true);
  assert.deepEqual(env.listed(), []);
  assert.deepEqual(env.listed({ includeArchived: true }), ['sess_a1']);
  assert.equal(existsSync(sessionPath('sess_a1')), true);
});

test('closing hides the session with no desktop attached', async (t) => {
  const env = setup(t, [agentSession('sess_a1', 'review1')], { desktop: false });
  bind(env, 'sess_a1', 'review1');
  const result = await env.closeFlow.close({ tag: 'review1' }, OWNER);
  assert.equal(result.closed, true);
  assert.equal(result.hideFailed, undefined);
  assert.deepEqual(env.listed(), []);
  assert.deepEqual(env.listed({ includeArchived: true }), ['sess_a1']);
});

test('cleanup never closes an idle agent whose undelivered result was pruned, even with force', async (t) => {
  const env = setup(t, [agentSession('sess_wait', 'wait')]);
  bind(env, 'sess_wait', 'wait');
  const task = registerBackgroundTask({
    surface: 'agent',
    context: OWNER,
    meta: { sessionId: 'sess_wait', tag: 'wait' },
  });
  completeBackgroundTask(task.taskId, { status: 'completed', result: { content: 'x' }, notify: false });
  const result = await env.closeFlow.cleanup({ force: true }, OWNER);
  assert.equal(result.tasksRemoved >= 1, true, 'the task was pruned');
  assert.equal(result.agentsClosed, 0);
  assert.deepEqual(env.closed, []);
  assert.deepEqual(env.listed(), ['sess_wait']);
});

test('parking releases the runtime but neither closes nor hides the agent, and refuses an undelivered result', async (t) => {
  const env = setup(t, [agentSession('sess_p1', 'park1'), agentSession('sess_p2', 'park2')]);
  const parked = [];
  env.mgr.parkSession = async (id) => {
    parked.push(id);
    return true;
  };
  bind(env, 'sess_p1', 'park1');
  bind(env, 'sess_p2', 'park2');
  const task = registerBackgroundTask({
    surface: 'agent',
    context: OWNER,
    meta: { sessionId: 'sess_p2', tag: 'park2' },
  });
  completeBackgroundTask(task.taskId, { status: 'completed', result: { content: 'x' }, notify: false });
  const [first, second] = [
    await env.closeFlow.parkIdle({ sessionId: 'sess_p1', tag: 'park1' }, OWNER),
    await env.closeFlow.parkIdle({ sessionId: 'sess_p2', tag: 'park2' }, OWNER),
  ];
  assert.equal(first.state, 'parked');
  assert.equal(second.state, 'undelivered');
  assert.deepEqual(parked, ['sess_p1']);
  assert.deepEqual(env.closed, []);
  assert.deepEqual(env.listed().sort(), ['sess_p1', 'sess_p2']);
});

test('a close that did not happen says why and leaves the agent listed', async (t) => {
  const env = setup(t, [agentSession('sess_a1', 'review1')]);
  bind(env, 'sess_a1', 'review1');
  env.failing.add('sess_a1');
  const result = await env.closeFlow.close({ tag: 'review1' }, OWNER);
  assert.equal(result.closed, false);
  assert.match(result.reason, /barrier did not land/);
  assert.deepEqual(env.listed(), ['sess_a1']);
});

test('cleanup closes delivered idle agents, hides leftovers, leaves running and undelivered ones', async (t) => {
  const env = setup(t, [
    agentSession('sess_done', 'done'),
    agentSession('sess_busy', 'busy', { status: 'running' }),
    agentSession('sess_wait', 'wait'),
    agentSession('sess_stuck', 'stuck'),
    agentSession('sess_left', 'left'),
  ]);
  bind(env, 'sess_done', 'done');
  bind(env, 'sess_busy', 'busy', 'running');
  bind(env, 'sess_wait', 'wait');
  bind(env, 'sess_stuck', 'stuck');
  env.running.add('sess_busy');
  env.failing.add('sess_stuck');
  const task = registerBackgroundTask({
    surface: 'agent',
    context: OWNER,
    meta: { sessionId: 'sess_wait', tag: 'wait' },
  });
  completeBackgroundTask(task.taskId, { status: 'completed', result: { content: 'x' }, notify: false });
  const stuck = registerBackgroundTask({
    surface: 'agent',
    context: OWNER,
    meta: { sessionId: 'sess_stuck', tag: 'stuck' },
  });
  completeBackgroundTask(stuck.taskId, { status: 'completed', result: { content: 'y' }, notify: false });
  stuck.notifiedWithBody = true;
  assert.notEqual(task.notifiedWithBody, true, 'its result is not delivered yet');

  const result = await env.closeFlow.cleanup({}, OWNER);
  assert.equal(result.agentsClosed, 1);
  assert.equal(result.leftoversHidden, 1);
  assert.deepEqual(result.notClosed, [{ tag: 'stuck', sessionId: 'sess_stuck', reason: 'barrier did not land' }]);
  assert.deepEqual(env.closed, ['sess_done']);
  assert.deepEqual(Object.keys(env.archived).sort(), ['sess_done', 'sess_left']);
  assert.deepEqual(env.listed().sort(), ['sess_busy', 'sess_stuck', 'sess_wait']);
});

test('cleanup hides a few hundred leftovers without holding the event loop', async (t) => {
  const leftovers = Array.from({ length: 400 }, (_, i) => agentSession(`sess_l${i}`, `old${i}`));
  const env = setup(t, leftovers);
  let turns = 0;
  const ticker = setInterval(() => {}, 1);
  const spin = () =>
    setImmediate(() => {
      turns += 1;
      if (turns < 1e9) spin();
    });
  spin();
  const started = performance.now();
  const result = await env.closeFlow.cleanup({}, OWNER);
  const elapsed = performance.now() - started;
  clearInterval(ticker);
  turns = 1e9;
  assert.equal(result.leftoversHidden, 400);
  assert.deepEqual(env.listed(), []);
  assert.ok(turns >= 400, 'the loop turned between hides');
  console.log(`cleanup hid 400 leftovers in ${elapsed.toFixed(0)} ms`);
});

test('a send to a closed tag still starts a fresh session under it; the old one stays hidden', async (t) => {
  const env = setup(t, [agentSession('sess_old', 'review')]);
  bind(env, 'sess_old', 'review');
  await env.closeFlow.close({ tag: 'review' }, OWNER);
  const calls = [];
  const sendFlow = {
    async prepareSend(args, context) {
      const sessionId = env.registry.resolveTag(args.tag, context);
      if (!sessionId) throw new Error(`agent send: target "${args.tag}" not found`);
      return { args, sessionId, prompt: args.message };
    },
    async adoptCaller() {},
    async dispatchToExistingSession(prepared) {
      calls.push({ dispatched: prepared.sessionId });
    },
  };
  const spawnFlow = {
    startDeferredSpawnJob(args, _cwd, _ctx, _notify, options) {
      calls.push({ spawned: args.tag, agent: args.agent, ...options });
      return {};
    },
  };
  const { send } = createSendDispatch({
    registry: env.registry,
    defaultCwd: env.root,
    sendFlow,
    spawnFlow,
    spawnResult: () => 'spawned',
  });
  const request = { scopedContext: OWNER, context: OWNER, notifyContext: OWNER, callerCwd: env.root };
  assert.equal(await send({ type: 'send', tag: 'review', message: 'again' }, request), 'spawned');
  assert.deepEqual(calls, [{ spawned: 'review', agent: 'reviewer', respawned: true }]);
  assert.deepEqual(env.listed(), []);
});

test('a send that revives a closed session lists it again', async (t) => {
  const env = setup(t, [agentSession('sess_old', 'review')]);
  bind(env, 'sess_old', 'review');
  await env.closeFlow.close({ tag: 'review' }, OWNER);
  assert.deepEqual(env.listed(), []);
  const sendFlow = createSendFlow({
    mgr: env.mgr,
    cfgMod: { loadConfig: () => ({}) },
    defaultCwd: env.root,
    sessionSurface: null,
    canUseSessionSurface: () => false,
    registry: env.registry,
    views: { isSessionBusy: () => false, renderJob: () => ({ status: 'running' }) },
    spawnFlow: { startJob: () => ({}), workerNotifyFn: () => () => {} },
  });
  const session = env.sessions.get('sess_old');
  await sendFlow
    .dispatchToExistingSession({ args: { tag: 'review' }, session, sessionId: 'sess_old', prompt: 'again' }, OWNER)
    .catch(() => {});
  assert.deepEqual(env.listed(), ['sess_old']);
});

test('an idle agent is released after the idle period by a timer armed only while it is idle', async (t) => {
  const { createIdleRelease, IDLE_RELEASE_MS } = await import('./close-flow/idle-release.mjs');
  const env = setup(t, [agentSession('sess_i1', 'idle1')]);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const released = [];
  const idle = createIdleRelease({
    registry: env.registry,
    release: async (row) => {
      released.push(row.sessionId);
      return { state: 'closed' };
    },
  });
  t.after(() => idle.dispose());
  idle.check();
  assert.equal(released.length, 0, 'nothing armed while no agent is idle');
  bind(env, 'sess_i1', 'idle1');
  idle.check();
  mock.timers.tick(IDLE_RELEASE_MS - 5000);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(released, []);
  mock.timers.tick(10_000);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(released, ['sess_i1']);
});

test('a release already queued when the timers are disposed does not run, and nothing is armed after', async (t) => {
  const { createIdleRelease, IDLE_RELEASE_MS } = await import('./close-flow/idle-release.mjs');
  const env = setup(t, [agentSession('sess_i1', 'idle1')]);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const released = [];
  const idle = createIdleRelease({
    registry: env.registry,
    release: async (row) => {
      released.push(row.sessionId);
      return { state: 'busy' };
    },
  });
  bind(env, 'sess_i1', 'idle1');
  idle.check();
  // The timer fires and queues its release; the disposal comes before it runs.
  mock.timers.tick(IDLE_RELEASE_MS);
  idle.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  idle.check();
  mock.timers.tick(IDLE_RELEASE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(released, []);
});

test("another Lead's pruned undelivered result under the same tag does not hold this Lead's agent", async (t) => {
  const env = setup(t, [agentSession('sess_mine', 'shared')]);
  bind(env, 'sess_mine', 'shared');
  const other = { callerSessionId: 'lead-b', clientHostPid: 4343 };
  const task = registerBackgroundTask({
    surface: 'agent',
    context: other,
    meta: { sessionId: 'sess_theirs', tag: 'shared' },
  });
  completeBackgroundTask(task.taskId, { status: 'completed', result: { content: 'x' }, notify: false });
  const theirs = await env.closeFlow.cleanup({ force: true }, other);
  assert.equal(theirs.tasksRemoved >= 1, true, "the other Lead's undelivered task was pruned");
  const result = await env.closeFlow.cleanup({}, OWNER);
  assert.equal(result.agentsClosed, 1);
  assert.deepEqual(env.closed, ['sess_mine']);
});

test('cleanup names a closed agent whose session could not be hidden', async (t) => {
  const env = setup(t, [agentSession('sess_done', 'done')], { desktop: false });
  bind(env, 'sess_done', 'done');
  // The hidden set cannot be saved: its file's place is taken by a directory.
  mkdirSync(`${env.root}/session-hidden.json`);
  const result = await env.closeFlow.cleanup({}, OWNER);
  assert.equal(result.agentsClosed, 1);
  assert.equal(result.notHidden.length, 1);
  assert.deepEqual(
    { tag: result.notHidden[0].tag, sessionId: result.notHidden[0].sessionId },
    { tag: 'done', sessionId: 'sess_done' }
  );
  assert.match(result.notHidden[0].reason, /could not save the hidden sessions/);
});

test('cleanup forgets the hidden sessions that were deleted', async (t) => {
  const env = setup(t, [agentSession('sess_a1', 'review1'), agentSession('sess_a2', 'review2')], { desktop: false });
  bind(env, 'sess_a1', 'review1');
  bind(env, 'sess_a2', 'review2');
  await env.closeFlow.close({ tag: 'review1' }, OWNER);
  await env.closeFlow.close({ tag: 'review2' }, OWNER);
  assert.deepEqual(Object.keys(daemonHiddenSessions()).sort(), ['sess_a1', 'sess_a2']);
  env.mgr.sessionGone = async (id) => id === 'sess_a1';
  await env.closeFlow.cleanup({}, OWNER);
  assert.deepEqual(Object.keys(daemonHiddenSessions()), ['sess_a2']);
});

test('cleanup still reports what it did when the hidden set cannot be saved after forgetting a deleted session', async (t) => {
  const env = setup(t, [agentSession('sess_a1', 'review1'), agentSession('sess_done', 'done')], { desktop: false });
  bind(env, 'sess_a1', 'review1');
  await env.closeFlow.close({ tag: 'review1' }, OWNER);
  bind(env, 'sess_done', 'done');
  env.mgr.sessionGone = async (id) => id === 'sess_a1';
  rmSync(`${env.root}/session-hidden.json`);
  mkdirSync(`${env.root}/session-hidden.json`);
  const result = await env.closeFlow.cleanup({}, OWNER);
  assert.equal(result.agentsClosed, 1);
  assert.deepEqual(result.notHidden.map((entry) => entry.sessionId), ['sess_done']);
});
