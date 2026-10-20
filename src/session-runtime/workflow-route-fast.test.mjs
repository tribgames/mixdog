import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelRouteApi } from './model-route-api.mjs';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import { createWorkflowRouteHelpers } from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';

test('Maintainer Fast off survives save and route reload', async () => {
  const route = {
    provider: 'cursor-oauth',
    model: 'gpt-5.6-sol',
    effort: 'low',
    fast: false,
  };
  let config = {
    agents: {
      maintainer: { ...route, fast: true },
    },
  };
  const helpers = createWorkflowRouteHelpers({ findPreset: () => null });
  const api = createWorkflowAgentsApi({
    getConfig: () => config,
    resolveRoute: (_config, requested) => ({ ...requested }),
    lookupModelMeta: async () => ({
      id: route.model,
      provider: route.provider,
      fastCapable: true,
      fastEfforts: ['low'],
    }),
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    ensureProvidersReady: async () => {},
    agentRouteFromConfig: helpers.agentRouteFromConfig,
  });

  const saved = await api.setAgentRoute('maintainer', route);
  const reloaded = createWorkflowRouteHelpers({ findPreset: () => null }).agentRouteFromConfig(config, 'maintainer');

  assert.equal(saved.fast, false);
  assert.equal(config.agents.maintainer.fast, false);
  assert.equal(reloaded.fast, false);
});

test('agent contextPercent is saved, preserved, cleared and dropped on model change', async () => {
  const helpers = createWorkflowRouteHelpers({ findPreset: () => null });
  let config = { agents: {} };
  const api = createWorkflowAgentsApi({
    getConfig: () => config,
    // Main's modelSettings bucket would leak contextPercent 90 through resolveRoute.
    resolveRoute: (_config, requested) => ({ contextPercent: 90, ...requested }),
    lookupModelMeta: async () => ({}),
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    ensureProvidersReady: async () => {},
    agentRouteFromConfig: helpers.agentRouteFromConfig,
  });
  const base = { provider: 'anthropic-oauth', model: 'claude-sonnet-5-5' };

  await api.setAgentRoute('reviewer', { ...base, contextPercent: 42 });
  assert.equal(config.agents.reviewer.contextPercent, 40);
  assert.equal(helpers.agentRouteFromConfig(config, 'reviewer').contextPercent, 40);

  await api.setAgentRoute('reviewer', { effort: 'low' });
  assert.equal(config.agents.reviewer.contextPercent, 40);

  await api.setAgentRoute('reviewer', { contextPercent: null });
  assert.equal(Object.hasOwn(config.agents.reviewer, 'contextPercent'), false);

  await api.setAgentRoute('reviewer', { contextPercent: 70 });
  await api.setAgentRoute('reviewer', { model: 'claude-opus-5-5' });
  assert.equal(Object.hasOwn(config.agents.reviewer, 'contextPercent'), false);
});

test('turning an agent off with an empty provider also drops its route override', async () => {
  const main = { provider: 'anthropic-oauth', model: 'claude-opus-5-5', effort: 'high' };
  let config = {
    agents: { worker: { provider: 'anthropic-oauth', model: 'claude-sonnet-5-5', effort: 'low' } },
  };
  const helpers = createWorkflowRouteHelpers({ findPreset: () => null });
  const api = createWorkflowAgentsApi({
    getConfig: () => config,
    resolveRoute: (_config, requested) => ({ ...main, ...requested }),
    lookupModelMeta: async () => ({}),
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    ensureProvidersReady: async () => {},
    agentRouteFromConfig: helpers.agentRouteFromConfig,
  });

  const saved = await api.setAgentRoute('worker', { provider: '', disabled: true });

  assert.equal(saved.disabled, true);
  assert.equal(saved.inherited, true);
  assert.equal(saved.model, main.model);
  assert.equal(Object.hasOwn(config.agents || {}, 'worker'), false);
  assert.equal(helpers.agentRouteFromConfig(config, 'worker'), null);
});

test('Web Search Fast off survives save and route reload', async () => {
  let config = {};
  let webSearchRoute = null;
  const api = createModelRouteApi({
    getConfig: () => config,
    getWebSearchRouteState: () => webSearchRoute,
    setWebSearchRouteState: (next) => {
      webSearchRoute = next;
    },
    lookupModelMeta: async () => ({ id: 'gpt-5.6-sol', provider: 'openai-oauth' }),
    webSearchCapableFor: () => true,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    ensureFullConfig: () => config,
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    invalidateProviderCaches: () => {},
  });

  const saved = await api.setWebSearchRoute({
    provider: 'openai-oauth',
    model: 'gpt-5.6-sol',
    fast: false,
  });
  const reloaded = api.getWebSearchRoute();

  assert.equal(saved.fast, false);
  assert.equal(config.webSearchRoute.fast, false);
  assert.equal(reloaded.fast, false);
});

// Compare-and-set fill (`onlyIfEmpty`): the model lookup is the await between
// the first emptiness check and the write, where a pick can land.
function onlyIfEmptyApi(initial) {
  const helpers = createWorkflowRouteHelpers({ findPreset: () => null });
  // disk: what another process wrote to the config file; the debounced change
  // notification has not delivered it, only a synchronous re-read (reload) can.
  const state = { config: initial, gate: null, disk: null };
  const api = createWorkflowAgentsApi({
    getConfig: () => state.config,
    resolveRoute: (_config, requested) => ({ ...requested }),
    lookupModelMeta: async () => {
      await state.gate;
      return {};
    },
    saveConfigAndAdopt: (next) => {
      state.config = next;
    },
    ensureProvidersReady: async () => {},
    reloadFullConfig: () => {
      if (state.disk) state.config = state.disk;
    },
    agentRouteFromConfig: helpers.agentRouteFromConfig,
  });
  return { api, state };
}

const FILL = { provider: 'openai', model: 'gpt-fill', onlyIfEmpty: true };
const PICKED = { provider: 'anthropic-oauth', model: 'claude-picked' };

test('onlyIfEmpty fills an agent without a route and keeps an off agent off', async () => {
  const { api, state } = onlyIfEmptyApi({ agents: {}, disabledAgents: ['reviewer'] });
  const saved = await api.setAgentRoute('reviewer', FILL);
  assert.equal(saved.skipped, undefined);
  assert.equal(state.config.agents.reviewer.model, 'gpt-fill');
  assert.deepEqual(state.config.disabledAgents, ['reviewer']);
});

test('onlyIfEmpty never replaces a route the agent already has', async () => {
  const { api, state } = onlyIfEmptyApi({ agents: { reviewer: { ...PICKED } } });
  const answer = await api.setAgentRoute('reviewer', FILL);
  assert.equal(answer.skipped, true);
  assert.equal(state.config.agents.reviewer.model, 'claude-picked');
});

test('a route picked between the emptiness read and the write is not overwritten', async () => {
  const { api, state } = onlyIfEmptyApi({ agents: {} });
  let release;
  state.gate = new Promise((resolve) => {
    release = resolve;
  });
  const fill = api.setAgentRoute('reviewer', FILL);
  await Promise.resolve();
  // The user's pick lands while the fill is still resolving its model.
  state.config = { ...state.config, agents: { reviewer: { ...PICKED } } };
  release();
  const answer = await fill;
  assert.equal(answer.skipped, true);
  assert.equal(state.config.agents.reviewer.model, 'claude-picked');
});

test('a route another process wrote to the config file is found by the re-read before the save', async () => {
  const { api, state } = onlyIfEmptyApi({ agents: {} });
  let release;
  state.gate = new Promise((resolve) => {
    release = resolve;
  });
  const fill = api.setAgentRoute('reviewer', FILL);
  await Promise.resolve();
  // Persisted by another process; this runtime's config does not hold it yet.
  state.disk = { agents: { reviewer: { ...PICKED } } };
  release();
  const answer = await fill;
  assert.equal(answer.skipped, true);
  assert.equal(answer.model, 'claude-picked');
  assert.equal(state.config.agents.reviewer.model, 'claude-picked');
});
