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
