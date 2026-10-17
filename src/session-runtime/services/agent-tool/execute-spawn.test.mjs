import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpawnDispatch } from './execute-spawn.mjs';
import { createSendFlow } from './send-flow.mjs';

// Spawning onto a live tag with an explicit model: the requested route is
// handed to the session's route API (saved now, applied from the next turn)
// before the prompt is dispatched, busy or idle.

const CATALOG = [
  { provider: 'openai', id: 'gpt-5', display: 'GPT 5' },
  { provider: 'anthropic', id: 'opus', display: 'Opus' },
];

function harness({ busy = false, sessionSurface = {} } = {}) {
  const events = [];
  const session = { id: 'child', agent: 'worker', provider: 'openai', model: 'gpt-5', effort: 'medium', fast: false };
  const surface = {
    setRoute: async ({ route }) => {
      events.push(['setRoute', route]);
    },
    enqueueTurn: async () => {
      events.push(['enqueue']);
      return { queueDepth: 1 };
    },
    ...sessionSurface,
  };
  const registry = {
    resolveTag: () => 'child',
    wantsSessionScan: () => false,
    getLiveSession: () => session,
    refreshTagsFromSessions() {},
    tagForSession: () => 'worker',
  };
  const sendFlow = createSendFlow({
    mgr: { getSession: () => session },
    defaultCwd: process.cwd(),
    sessionSurface: surface,
    canUseSessionSurface: () => true,
    registry,
    views: { isSessionBusy: () => busy, renderJob: () => ({ status: 'running' }) },
    spawnFlow: {
      startJob: () => {
        events.push(['startJob']);
        return {};
      },
    },
  });
  const dispatch = createSpawnDispatch({
    registry,
    terminalTrace: {},
    sendFlow,
    spawnFlow: {},
    spawnResult: () => assert.fail('a reused tag must not spawn'),
    listProviderModels: async () => CATALOG,
  });
  const spawn = (args) =>
    dispatch.spawn({ tag: 'worker', prompt: 'go', ...args }, { scopedContext: {}, context: {}, notifyContext: null });
  return { events, spawn };
}

test('an explicit different model is applied to the idle reused session before the prompt runs', async () => {
  const { events, spawn } = harness();
  await spawn({ model: 'opus', effort: 'low', fast: true });
  assert.deepEqual(events, [
    ['setRoute', { provider: 'anthropic', model: 'opus', effort: 'low', fast: true }],
    ['startJob'],
  ]);
});

test('a busy reused session saves the requested model, then queues the prompt', async () => {
  const { events, spawn } = harness({ busy: true });
  await spawn({ model: 'opus' });
  assert.deepEqual(events, [['setRoute', { provider: 'anthropic', model: 'opus' }], ['enqueue']]);
});

test('a spawn that names no model or tuning leaves the route alone', async () => {
  const { events, spawn } = harness();
  await spawn({});
  assert.deepEqual(events, [['startJob']]);
});

test('only the named tuning is requested, with or without a model, never a descriptor snapshot', async () => {
  const { events, spawn } = harness();
  await spawn({ effort: 'low' });
  await spawn({ fast: true });
  await spawn({ autoEffort: false });
  await spawn({ autoEffort: true });
  await spawn({ model: 'gpt-5', fast: false });
  assert.deepEqual(events, [
    ['setRoute', { effort: 'low' }],
    ['startJob'],
    ['setRoute', { fast: true }],
    ['startJob'],
    ['setRoute', { autoEffort: false }],
    ['startJob'],
    ['setRoute', { autoEffort: true }],
    ['startJob'],
    ['setRoute', { provider: 'openai', model: 'gpt-5', fast: false }],
    ['startJob'],
  ]);
});

test('a busy session saves a tuning-only change for its next turn', async () => {
  const { events, spawn } = harness({ busy: true });
  await spawn({ fast: true });
  assert.deepEqual(events, [['setRoute', { fast: true }], ['enqueue']]);
});

test('a surface that cannot set a route refuses instead of silently ignoring the model', async () => {
  const { events, spawn } = harness({ sessionSurface: { setRoute: undefined } });
  await assert.rejects(spawn({ model: 'opus' }), /cannot change the model/);
  assert.deepEqual(events, []);
});
