// A reused worker follows its agent's configured model on the next `agent
// send`, as a bot's home chat does; one started on an explicit model keeps it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSendFlow } from './send-flow.mjs';

function flow(session, config) {
  const routes = [];
  const sendFlow = createSendFlow({
    mgr: { getSession: () => session },
    cfgMod: { loadConfig: () => config },
    defaultCwd: process.cwd(),
    sessionSurface: {
      setRoute: async ({ route }) => routes.push(route),
      enqueueTurn: async () => ({ queueDepth: 1 }),
    },
    canUseSessionSurface: () => true,
    registry: { tagForSession: () => 'w-1' },
    views: { isSessionBusy: () => true },
    spawnFlow: {},
  });
  const send = () =>
    sendFlow.dispatchToExistingSession({ args: {}, session, sessionId: session.id, prompt: 'more' }, null);
  return { routes, send };
}

const config = { agents: { worker: { provider: 'openai', model: 'gpt-new' } } };

test('a worker on its agent route takes the model picked for the agent since its spawn', async () => {
  const session = { id: 'sess_w1', agent: 'worker', presetName: 'agent-worker', provider: 'openai', model: 'gpt-old' };
  const { routes, send } = flow(session, config);
  await send();
  assert.deepEqual(
    routes.map((route) => [route.provider, route.model]),
    [['openai', 'gpt-new']]
  );
});

// The agent's model was picked a moment ago: the runtime holds it, the file
// write is still debounced. The send reads what the runtime holds.
test('a model picked just before the send is followed before its debounced write lands', async () => {
  const { createConfigWriters } = await import('../../config-lifecycle/config-writers.mjs');
  const disk = { agents: { worker: { provider: 'openai', model: 'gpt-old' } } };
  const writers = createConfigWriters({
    cfgMod: {
      saveConfigPatchAsync: async (changes) => Object.assign(disk, changes.at(-1)),
    },
    sharedCfgMod: { pendingConfigWrites: async () => {} },
  });
  writers.queueConfigChanges([config]);
  const session = { id: 'sess_w3', agent: 'worker', presetName: 'agent-worker', provider: 'openai', model: 'gpt-old' };
  const routes = [];
  const sendFlow = createSendFlow({
    mgr: { getSession: () => session },
    cfgMod: { loadConfig: () => structuredClone(disk) },
    defaultCwd: process.cwd(),
    sessionSurface: {
      setRoute: async ({ route }) => routes.push(route),
      enqueueTurn: async () => ({ queueDepth: 1 }),
    },
    canUseSessionSurface: () => true,
    registry: { tagForSession: () => 'w-1' },
    views: { isSessionBusy: () => true },
    spawnFlow: {},
  });
  await sendFlow.dispatchToExistingSession({ args: {}, session, sessionId: session.id, prompt: 'more' }, null);
  assert.deepEqual(
    routes.map((route) => route.model),
    ['gpt-new']
  );
});

test('a worker follows an effort or Fast change of its agent route on the same model', async () => {
  const session = {
    id: 'sess_w4',
    agent: 'worker',
    presetName: 'agent-worker',
    provider: 'openai',
    model: 'gpt-new',
    effort: 'low',
  };
  const { routes, send } = flow(session, {
    agents: { worker: { provider: 'openai', model: 'gpt-new', effort: 'high', fast: true } },
  });
  await send();
  assert.equal(routes.length, 1);
  assert.equal(routes[0].effort, 'high');
  assert.equal(routes[0].fast, true);
});

test('an in-process reused worker takes an effort/Fast change of its agent route in place', async () => {
  const session = {
    id: 'sess_w5',
    agent: 'worker',
    presetName: 'agent-worker',
    provider: 'openai',
    model: 'gpt-new',
    effort: 'low',
  };
  const updates = [];
  const sendFlow = createSendFlow({
    mgr: {
      getSession: () => session,
      updateSessionRoute: (id, route, options) => updates.push({ id, route, options }),
      enqueuePendingMessage: () => 1,
    },
    cfgMod: { loadConfig: () => ({ agents: { worker: { provider: 'openai', model: 'gpt-new', effort: 'high' } } }) },
    defaultCwd: process.cwd(),
    canUseSessionSurface: () => false,
    registry: { tagForSession: () => 'w-5' },
    views: { isSessionBusy: (id) => updates.length > 0 && id === 'sess_w5' },
    spawnFlow: {},
  });
  await sendFlow.dispatchToExistingSession({ args: {}, session, sessionId: session.id, prompt: 'more' }, null);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].route.effort, 'high');
  assert.equal(updates[0].options.crossProvider, false);
});

test('a busy in-process worker drops its hold when the agent route is saved back to the running one', async () => {
  const session = { id: 'sess_w6', agent: 'worker', presetName: 'agent-worker', provider: 'openai', model: 'gpt-a' };
  let config = { agents: { worker: { provider: 'openai', model: 'gpt-b' } } };
  const updates = [];
  const sendFlow = createSendFlow({
    mgr: {
      getSession: () => session,
      updateSessionRoute: (id, route) => updates.push({ id, route }),
      holdSessionRoute: (_id, route) => {
        if (route) session.heldRoute = { ...route };
        else delete session.heldRoute;
        return session;
      },
      enqueuePendingMessage: () => 1,
    },
    cfgMod: { loadConfig: () => config },
    defaultCwd: process.cwd(),
    canUseSessionSurface: () => false,
    registry: { tagForSession: () => 'w-6' },
    views: { isSessionBusy: () => true },
    spawnFlow: {},
  });
  const send = () =>
    sendFlow.dispatchToExistingSession({ args: {}, session, sessionId: session.id, prompt: 'more' }, null);
  await send();
  assert.equal(session.heldRoute?.model, 'gpt-b', 'B is held while A runs');
  await send();
  assert.equal(session.heldRoute?.model, 'gpt-b', 'a send on the same saved route keeps the one hold');
  config = { agents: { worker: { provider: 'openai', model: 'gpt-a' } } };
  await send();
  assert.equal(session.heldRoute, undefined, 'A saved again: the next turn stays on A');
  config = { agents: { worker: { provider: 'openai', model: 'gpt-c' } } };
  await send();
  assert.equal(session.heldRoute?.model, 'gpt-c');
  assert.deepEqual(updates, [], 'a busy worker is never rerouted mid-turn');
});

test('a worker started on an explicit model keeps it', async () => {
  const session = { id: 'sess_w2', agent: 'worker', presetName: '__direct__', provider: 'openai', model: 'gpt-old' };
  const { routes, send } = flow(session, config);
  await send();
  assert.deepEqual(routes, []);
});
