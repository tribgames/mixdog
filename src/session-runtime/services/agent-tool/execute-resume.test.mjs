import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { mock } from 'node:test';

import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

mock.module('../../../vendor/statusline/src/gateway/session-routes.mjs', {
  namedExports: { clearGatewaySessionRoute: () => true, writeGatewaySessionRoutes: () => true },
});
const { createTagRegistry } = await import('./tag-registry.mjs');
const { createSendDispatch } = await import('./execute-send.mjs');
const { createSpawnDispatch } = await import('./execute-spawn.mjs');
const { createSendFlow } = await import('./send-flow.mjs');
const { createTerminalTrace } = await import('./terminal-trace.mjs');
const { sessionPath } = await import('../../../runtime/agent/orchestrator/session/store/session-paths.mjs');

const OWNER = { callerSessionId: 'lead-a', clientHostPid: 4242 };
const DAY = 86_400_000;

// A fake send flow: resolves live tags through the registry and records every
// dispatch onto an existing session; `gate` holds a dispatch open after
// `onDispatch` saw it start.
function fakeSendFlow(registry, calls, gate = null, onDispatch = () => {}) {
  return {
    async prepareSend(args, context) {
      const sessionId = registry.resolveTag(args.tag, context);
      if (!sessionId) throw new Error(`agent send: target "${args.tag}" not found`);
      return { args, sessionId, prompt: args.message || args.prompt };
    },
    async adoptCaller() {},
    async dispatchToExistingSession(prepared, _notifyContext, extras) {
      calls.push({ dispatched: prepared.sessionId, prompt: prepared.prompt, extras });
      onDispatch();
      if (gate) await gate;
      calls.push({ settled: prepared.sessionId });
      return 'dispatched';
    },
  };
}

// A reaped worker: its index row is gone, its session record (tag, owner,
// agent, cwd, last turn) and transcript stay on disk.
function setup(t, { record = {}, fileGone = false, cwdGone = false, released = false, flow = null } = {}) {
  const root = makeTempDirSync('tag-resume');
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const cwd = join(root, 'work');
  if (!cwdGone) mkdirSync(cwd);
  const session = {
    id: 'sess_old',
    agentTag: 'review',
    parentSessionId: 'lead-a',
    ownerSessionId: 'lead-a',
    agent: 'reviewer',
    cwd,
    clientHostPid: 4242,
    status: 'idle',
    createdAt: Date.now() - 3 * DAY,
    lastUsedAt: Date.now() - 2 * DAY,
    lastTurnCompletedAt: Date.now() - 2 * DAY,
    closed: false,
    closeProvenance: 1,
    messages: [{ role: 'user', content: 'first brief' }],
    ...record,
  };
  if (!fileGone) {
    mkdirSync(dirname(sessionPath(session.id)), { recursive: true });
    writeFileSync(sessionPath(session.id), JSON.stringify(session));
  }
  const routeUpdates = [];
  const mgr = {
    getSession: (id) => (id === session.id ? session : null),
    listSessions: ({ includeClosed = false } = {}) => (includeClosed || !session.closed ? [session] : []),
    getSessionRuntime: () => null,
    updateSessionRoute: (id, route, options) => routeUpdates.push({ id, route, crossProvider: options.crossProvider }),
  };
  const registry = createTagRegistry({ dataDir: root, cfgMod: { loadConfig: () => ({}) }, mgr });
  if (released) registry.markReleased([session.id]);
  const calls = [];
  const sendFlow = flow ? flow({ mgr, registry, calls, root }) : fakeSendFlow(registry, calls);
  const spawnFlow = {
    startDeferredSpawnJob(args, _callerCwd, _context, _notifyContext, options) {
      calls.push({ spawned: args.tag, agent: args.agent, cwd: args.cwd || null, ...options });
      return {};
    },
  };
  const deps = { registry, defaultCwd: root, sendFlow, spawnFlow, spawnResult: () => 'spawned' };
  const { send } = createSendDispatch(deps);
  const { spawn } = createSpawnDispatch({ ...deps, terminalTrace: createTerminalTrace({ registry }) });
  const request = (context = OWNER) => ({ scopedContext: context, context, notifyContext: context, callerCwd: root });
  t.after(() => {
    registry.dispose();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    registry,
    session,
    calls,
    cwd,
    routeUpdates,
    reap: () => registry.tombstoneTerminalSession('review', session.id, session),
    send: (args, context) => send({ type: 'send', ...args }, request(context)),
    spawn: (args, context) => spawn({ type: 'spawn', ...args }, request(context)),
  };
}

const RESUMED = [
  { dispatched: 'sess_old', prompt: 'next', extras: { resumed: true } },
  { settled: 'sess_old' },
];

test('a send to a reaped tag continues its saved session and consumes the tombstone', async (t) => {
  const env = setup(t);
  assert.equal(env.reap(), true);
  assert.equal(await env.send({ tag: 'review', message: 'next' }), 'dispatched');
  assert.deepEqual(env.calls, RESUMED);
  assert.equal(env.registry.tagTombstoneForTag('review', OWNER), null);
});

test('an explicit-tag spawn of a reaped tag continues its saved session', async (t) => {
  const env = setup(t);
  env.reap();
  assert.equal(await env.spawn({ tag: 'review', agent: 'reviewer', prompt: 'next' }), 'dispatched');
  assert.deepEqual(env.calls, RESUMED);
});

test('a pruned tag whose tombstone was capped out still resumes for its owner only', async (t) => {
  // No row and no tombstone: only the session record proves the tag was used.
  const env = setup(t);
  assert.equal(await env.send({ tag: 'review', message: 'next' }), 'dispatched');
  assert.deepEqual(env.calls, RESUMED);
  await assert.rejects(env.send({ tag: 'review', message: 'next' }, { callerSessionId: 'lead-b' }), /not found/);
  await assert.rejects(env.send({ tag: 'never-used', message: 'next', agent: 'reviewer' }), /not found/);
  // A terminal pid alone is no durable owner proof.
  await assert.rejects(env.send({ tag: 'review', message: 'next' }, { clientHostPid: 4242 }), /not found/);
});

test('a pruned tag whose session file is gone respawns fresh with its old identity', async (t) => {
  const env = setup(t, { fileGone: true });
  assert.equal(await env.send({ tag: 'review', message: 'next' }), 'spawned');
  assert.deepEqual(env.calls, [{ spawned: 'review', agent: 'reviewer', cwd: env.cwd, respawned: true }]);
});

for (const [label, options] of [
  ['closed', { record: { closed: true } }],
  ['released by its owner', { released: true }],
]) {
  test(`a reaped session ${label} is never continued; the tag respawns fresh`, async (t) => {
    const env = setup(t, options);
    env.reap();
    assert.equal(await env.send({ tag: 'review', message: 'next' }), 'spawned');
    assert.deepEqual(env.calls, [{ spawned: 'review', agent: 'reviewer', cwd: env.cwd, respawned: true }]);
  });
}

test('an owner close outlives its released marker: the retained transcript is never resumed', async (t) => {
  // Closed by its owner after its last turn; the 7-day index marker has
  // expired, the row is pruned and the tombstone capped out.
  const closedAt = Date.now() - 8 * DAY;
  const lastTurn = closedAt - 60_000;
  const env = setup(t, { record: { lastUsedAt: lastTurn, lastTurnCompletedAt: lastTurn, ownerClosedAt: closedAt } });
  assert.equal(await env.send({ tag: 'review', message: 'next' }), 'spawned');
  assert.deepEqual(env.calls, [{ spawned: 'review', agent: 'reviewer', cwd: env.cwd, respawned: true }]);
  assert.equal(await env.spawn({ tag: 'review', prompt: 'next' }), 'spawned');
  assert.equal(env.calls[1].respawned, undefined, 'never a resume');
});

test('a rewind after the owner close moves lastUsedAt but never lifts the close', async (t) => {
  const closedAt = Date.now() - 8 * DAY;
  const lastTurn = closedAt - 60_000;
  const env = setup(t, {
    record: { lastTurnCompletedAt: lastTurn, ownerClosedAt: closedAt, lastUsedAt: closedAt + 60_000 },
  });
  assert.equal(await env.send({ tag: 'review', message: 'next' }), 'spawned');
  assert.deepEqual(env.calls, [{ spawned: 'review', agent: 'reviewer', cwd: env.cwd, respawned: true }]);
});

test('a record from before close provenance fails closed: an 8-day-old session respawns fresh', async (t) => {
  // It may have been closed by its owner under a build that recorded nothing:
  // no provenance, no ownerClosedAt, no released marker.
  const env = setup(t, { record: { closeProvenance: undefined, lastUsedAt: Date.now() - 8 * DAY } });
  assert.equal(await env.send({ tag: 'review', message: 'next' }), 'spawned');
  assert.deepEqual(env.calls, [{ spawned: 'review', agent: 'reviewer', cwd: env.cwd, respawned: true }]);
});

test('the resume decision never reads the stored transcript synchronously', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const env = setup(t);
  env.reap();
  const syncReads = [];
  const originals = { readFileSync: fs.readFileSync, openSync: fs.openSync };
  for (const name of Object.keys(originals)) {
    fs[name] = function (path, ...rest) {
      if (String(path).includes('sess_old.json')) syncReads.push([name, String(path)]);
      return originals[name].call(this, path, ...rest);
    };
  }
  syncBuiltinESMExports();
  try {
    assert.equal(await env.send({ tag: 'review', message: 'next' }), 'dispatched');
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
  assert.deepEqual(env.calls, RESUMED);
  assert.deepEqual(syncReads, []);
});

test('a turn completed after the owner close (the owner reused it) lifts the close', async (t) => {
  const closedAt = Date.now() - 8 * DAY;
  const reused = closedAt + 60_000;
  const env = setup(t, { record: { ownerClosedAt: closedAt, lastUsedAt: reused, lastTurnCompletedAt: reused } });
  assert.equal(await env.send({ tag: 'review', message: 'next' }), 'dispatched');
  assert.deepEqual(env.calls, RESUMED);
});

test('a missing saved working directory is an error naming it, never a spawn there', async (t) => {
  const env = setup(t, { cwdGone: true });
  env.reap();
  await assert.rejects(
    env.send({ tag: 'review', message: 'next' }),
    (err) => err.message.includes(`working directory "${env.cwd}" no longer exists`)
  );
  await assert.rejects(env.spawn({ tag: 'review', prompt: 'next' }), /no longer exists/);
  await assert.rejects(
    env.send({ tag: 'review', message: 'next', cwd: join(env.root, 'also-missing') }),
    /also-missing" is not a directory/
  );
  assert.deepEqual(env.calls, []);
  assert.ok(env.registry.tagTombstoneForTag('review', OWNER), 'a refused resume keeps the reap record');
});

test('a missing saved working directory with an existing explicit cwd respawns fresh there', async (t) => {
  const env = setup(t, { cwdGone: true });
  env.reap();
  const elsewhere = join(env.root, 'elsewhere');
  mkdirSync(elsewhere);
  assert.equal(await env.send({ tag: 'review', message: 'next', cwd: elsewhere }), 'spawned');
  assert.deepEqual(env.calls, [{ spawned: 'review', agent: 'reviewer', cwd: elsewhere, respawned: true }]);
});

test('an explicit spawn naming another agent gets a fresh session, not the saved one', async (t) => {
  const env = setup(t);
  env.reap();
  assert.equal(await env.spawn({ tag: 'review', agent: 'worker', prompt: 'next' }), 'spawned');
  assert.deepEqual(env.calls, [{ spawned: 'review', agent: 'worker', cwd: env.cwd, respawned: true }]);
});

test('two concurrent sends to a reaped tag resume it once and run their turns one after another', async (t) => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  let started;
  const firstStarted = new Promise((resolve) => {
    started = resolve;
  });
  const env = setup(t, { flow: ({ registry, calls }) => fakeSendFlow(registry, calls, gate, started) });
  env.reap();
  const first = env.send({ tag: 'review', message: 'next' });
  const second = env.send({ tag: 'review', message: 'after' });
  await firstStarted;
  // Give the second send every chance to race the open dispatch.
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.calls, [RESUMED[0]], 'the second send waits for the first resume');
  open();
  assert.deepEqual(await Promise.all([first, second]), ['dispatched', 'dispatched']);
  assert.deepEqual(env.calls, [
    ...RESUMED,
    { dispatched: 'sess_old', prompt: 'after', extras: undefined },
    { settled: 'sess_old' },
  ]);
});

for (const [label, canonical] of [
  ['an in-process', false],
  ['a daemon-owned', true],
]) {
  test(`${label} resumed session moved to its agent's new provider is rerouted before its turn`, async (t) => {
    const events = [];
    const config = { agents: { reviewer: { provider: 'anthropic', model: 'opus' } } };
    const env = setup(t, {
      record: { presetName: 'agent-reviewer', provider: 'openai', model: 'gpt-old' },
      flow: ({ mgr, registry, root }) =>
        createSendFlow({
          mgr,
          cfgMod: { loadConfig: () => config },
          defaultCwd: root,
          sessionSurface: { setRoute: async ({ route }) => events.push(['setRoute', route.provider, route.model]) },
          canUseSessionSurface: () => canonical,
          registry,
          views: { isSessionBusy: () => false, renderJob: () => ({ status: 'running' }) },
          spawnFlow: {
            startJob: (_type, meta) => {
              events.push(['startJob', meta.sessionId, meta.resumed]);
              return {};
            },
          },
        }),
    });
    env.reap();
    await env.send({ tag: 'review', message: 'next' });
    if (canonical) assert.deepEqual(events[0], ['setRoute', 'anthropic', 'opus']);
    else {
      // The manager's cross-provider route change drops the old provider's
      // replay state and context baselines (session-lifecycle.mjs updateSessionRoute).
      assert.deepEqual(env.routeUpdates, [
        { id: 'sess_old', route: env.routeUpdates[0].route, crossProvider: true },
      ]);
      assert.equal(env.routeUpdates[0].route.provider, 'anthropic');
    }
    assert.deepEqual(events.at(-1), ['startJob', 'sess_old', true]);
    assert.deepEqual(env.calls, []);
  });
}
