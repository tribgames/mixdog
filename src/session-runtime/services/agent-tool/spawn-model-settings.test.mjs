import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRequestedModel } from './model-select.mjs';
import { createSendFlow } from './send-flow.mjs';
import { resolveAgentSpawnPreset } from './spawn-preset.mjs';

const opts = (...values) => values.map((value) => ({ value, label: value, description: '' }));

// Catalog rows as the model picker hydrates them (provider-models/row-hydration.mjs).
const ROWS = [
  {
    provider: 'openai',
    id: 'gpt-fast',
    display: 'GPT Fast',
    catalogComplete: true,
    reasoningLevels: ['low', 'medium', 'high'],
    effortOptions: opts('low', 'medium', 'high'),
    defaultEffort: 'medium',
    savedEffort: 'low',
    fastCapable: true,
    fastPreferred: false,
  },
  {
    provider: 'openai',
    id: 'gpt-saved-fast',
    display: 'GPT Saved Fast',
    catalogComplete: true,
    reasoningLevels: ['low', 'medium', 'high'],
    effortOptions: opts('low', 'medium', 'high'),
    defaultEffort: 'medium',
    savedEffort: null,
    fastCapable: true,
    fastPreferred: true,
  },
  {
    provider: 'xai',
    id: 'grok-plain',
    display: 'Grok Plain',
    catalogComplete: true,
    reasoningLevels: [],
    effortOptions: [],
    defaultEffort: null,
    savedEffort: null,
    fastCapable: false,
    fastPreferred: true,
  },
  { provider: 'openai', id: 'twin-a', display: 'Twin', catalogComplete: true, effortOptions: [], fastCapable: false },
  { provider: 'openai', id: 'twin-b', display: 'Twin', catalogComplete: true, effortOptions: [], fastCapable: false },
];
const list = async () => ROWS;

const CONFIG = {
  agents: {
    worker: {
      provider: 'anthropic',
      model: 'opus',
      effort: 'high',
      fast: true,
      fallbacks: [
        { provider: 'openai', model: 'gpt-4' },
        { provider: 'gemini', model: 'pro' },
      ],
    },
  },
};

async function preset(args) {
  const resolved = await resolveRequestedModel({ type: 'spawn', agent: 'worker', ...args }, list);
  return resolveAgentSpawnPreset(CONFIG, resolved).preset;
}

const route = ({ provider, model, effort, fast }) => ({ provider, model, effort, fast });

test('no model runs the agent preset route', async () => {
  assert.deepEqual(route(await preset({})), { provider: 'anthropic', model: 'opus', effort: 'high', fast: true });
});

test('a model alone takes the model picker defaults for effort and fast', async () => {
  assert.deepEqual(route(await preset({ model: 'gpt-fast' })), {
    provider: 'openai',
    model: 'gpt-fast',
    effort: 'low',
    fast: false,
  });
  const saved = await preset({ model: 'gpt-saved-fast' });
  assert.deepEqual(route(saved), { provider: 'openai', model: 'gpt-saved-fast', effort: 'medium', fast: true });
});

test('effort and fast asked for win over the defaults', async () => {
  const asked = await preset({ model: 'gpt-fast', effort: 'high', fast: true });
  assert.deepEqual(route(asked), { provider: 'openai', model: 'gpt-fast', effort: 'high', fast: true });
  const off = await preset({ model: 'gpt-saved-fast', fast: false });
  assert.equal(off.fast, false);
});

test('a model without the asked effort gets what it offers; fast it cannot do is refused', async () => {
  const plain = await preset({ model: 'grok-plain', effort: 'high' });
  assert.deepEqual(route(plain), { provider: 'xai', model: 'grok-plain', effort: undefined, fast: false });
  await assert.rejects(
    preset({ model: 'grok-plain', fast: true }),
    /model "xai\/grok-plain" does not support fast/
  );
  assert.equal((await preset({ model: 'grok-plain', fast: false })).fast, false);
  const snapped = await preset({ model: 'gpt-fast', effort: 'xhigh' });
  assert.equal(snapped.effort, 'high');
});

test('the agent keeps its own settings on its own model', async () => {
  const rows = [{ ...ROWS[0], provider: 'anthropic', id: 'opus', effortOptions: opts('low', 'high'), reasoningLevels: ['low', 'high'] }];
  const resolved = await resolveRequestedModel({ agent: 'worker', model: 'opus' }, async () => rows);
  const own = resolveAgentSpawnPreset(CONFIG, resolved).preset;
  assert.deepEqual(route(own), { provider: 'anthropic', model: 'opus', effort: 'high', fast: true });
  const tuned = resolveAgentSpawnPreset(CONFIG, await resolveRequestedModel({ agent: 'worker', model: 'opus', effort: 'low', fast: false }, async () => rows));
  assert.deepEqual(route(tuned.preset), { provider: 'anthropic', model: 'opus', effort: 'low', fast: false });
});

test('a named model is strict: no fallback chain, on another model or on the agents own', async () => {
  const opus = [{ ...ROWS[0], provider: 'anthropic', id: 'opus', effortOptions: opts('low', 'high') }];
  const own = await resolveRequestedModel({ type: 'spawn', agent: 'worker', model: 'opus' }, async () => opus);
  for (const pinned of [await preset({ model: 'gpt-fast' }), resolveAgentSpawnPreset(CONFIG, own).preset]) {
    assert.equal(pinned.fallbacks, undefined);
    assert.equal(pinned.fallbackSource, undefined);
  }
  // Without a named model the agent keeps its chain.
  assert.deepEqual(await preset({}).then((own) => own.fallbackSource), { agent: 'worker' });
});

test('a worker spawned on a named model keeps it across sends, the agents own model included', async () => {
  const opus = [{ ...ROWS[0], provider: 'anthropic', id: 'opus', effortOptions: opts('low', 'high') }];
  for (const [rows, model] of [[opus, 'opus'], [ROWS, 'gpt-fast']]) {
    const resolved = await resolveRequestedModel({ type: 'spawn', agent: 'worker', model }, async () => rows);
    const spawned = resolveAgentSpawnPreset(CONFIG, resolved);
    const session = { id: 'sess_k', agent: 'worker', presetName: spawned.presetName, provider: spawned.preset.provider, model: spawned.preset.model };
    const routes = [];
    const moved = { agents: { worker: { provider: 'openai', model: 'gpt-new' } } };
    const sendFlow = createSendFlow({
      mgr: { getSession: () => session },
      cfgMod: { loadConfig: () => moved },
      defaultCwd: process.cwd(),
      sessionSurface: { setRoute: async ({ route }) => routes.push(route), enqueueTurn: async () => ({ queueDepth: 1 }) },
      canUseSessionSurface: () => true,
      registry: { tagForSession: () => 'w-1' },
      views: { isSessionBusy: () => true },
      spawnFlow: { workerTurns: { observe() {} } },
    });
    await sendFlow.dispatchToExistingSession({ args: {}, session, sessionId: session.id, prompt: 'more' }, null);
    assert.deepEqual(routes, [], model);
  }
  // Without a named model the worker follows the configuration.
  const followed = resolveAgentSpawnPreset(CONFIG, { agent: 'worker' });
  assert.equal(followed.presetName, 'AGENT WORKER');
});

test('an effort the model does not offer never reaches the route, a stored one included', async () => {
  const stale = { agents: { stale: { provider: 'openai', model: 'gpt-fast', effort: 'xhigh' }, bare: { provider: 'xai', model: 'grok-plain', effort: 'high' } } };
  const run = async (agent, args) =>
    resolveAgentSpawnPreset(stale, await resolveRequestedModel({ type: 'spawn', agent, ...args }, list)).preset;
  assert.equal((await run('stale', { model: 'gpt-fast' })).effort, 'low');
  assert.equal((await run('stale', { model: 'gpt-fast', effort: 'nonsense' })).effort, 'low');
  assert.equal((await run('stale', { model: 'gpt-fast', effort: 'high' })).effort, 'high');
  assert.equal((await run('bare', { model: 'grok-plain' })).effort, undefined);
});

test('unknown and ambiguous names fail with candidates', async () => {
  await assert.rejects(preset({ model: 'nothing-like-it' }), /not found; available: /);
  await assert.rejects(preset({ model: 'twin' }), /ambiguous: openai\/twin-a, openai\/twin-b/);
});
