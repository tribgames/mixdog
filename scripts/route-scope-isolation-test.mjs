// Route-scope isolation: Main, canonical agent, and search routes each own their
// model + effort + fast. config.modelSettings[provider/model] is MAIN-only
// state (resolveRoute reads it with priority over the lead preset), so an agent
// or search pick that reuses Main's model must neither read nor rewrite it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkflowAgentsApi } from '../src/session-runtime/workflow-agents-api.mjs';
import { createModelRouteApi } from '../src/session-runtime/model-route-api.mjs';
import { findPreset, makeResolveDefaultProvider, makeResolveRoute } from '../src/session-runtime/config-helpers.mjs';
import { createWorkflowRouteHelpers } from '../src/session-runtime/workflow.mjs';

const PROVIDER = 'anthropic-oauth';
const MAIN_MODEL = 'claude-opus-4-5';
const MAIN_KEY = `${PROVIDER}/${MAIN_MODEL}`;

const resolveDefaultProvider = () => PROVIDER;
const resolveRoute = makeResolveRoute(resolveDefaultProvider);
const { agentRouteFromConfig } = createWorkflowRouteHelpers({ resolveDefaultProvider, findPreset });

function baseConfig() {
  return {
    default: 'workflow-lead',
    presets: [{
      id: 'workflow-lead',
      name: 'WORKFLOW LEAD',
      type: 'agent',
      provider: PROVIDER,
      model: MAIN_MODEL,
      effort: 'high',
      tools: 'full',
    }],
    agents: { worker: { provider: PROVIDER, model: MAIN_MODEL, effort: 'medium' } },
    modelSettings: { [MAIN_KEY]: { effort: 'high', fast: true } },
    fastModels: {},
    searchRoute: { provider: PROVIDER, model: MAIN_MODEL, effort: 'medium' },
    providers: {},
  };
}

function harness() {
  let config = baseConfig();
  let searchRouteState = config.searchRoute;
  const diskWrites = [];
  const cfgMod = {
    getPluginData: () => 'data-dir',
    loadConfig: () => config,
    saveConfig: (next) => { diskWrites.push(next); return next; },
  };
  const shared = {
    getConfig: () => config,
    getRoute: () => resolveRoute(config, {}),
    setRouteState: () => {},
    getSession: () => null,
    setSession: () => {},
    cfgMod,
    reg: {},
    mgr: {},
    resolveRoute,
    lookupModelMeta: async (_provider, model) => ({ id: model }),
    adoptConfig: (next) => { config = next; return config; },
    saveConfigAndAdopt: (next) => { config = next; return config; },
    ensureProvidersReady: async () => {},
    invalidateContextStatusCache: () => {},
  };
  const workflowApi = createWorkflowAgentsApi({
    ...shared,
    STANDALONE_DATA_DIR: 'data-dir',
    displayConfig: () => config,
    agentRouteFromConfig,
    loadAgentDefinition: () => null,
    activeWorkflowId: () => 'default',
    listWorkflowPacks: () => [],
    loadWorkflowPack: () => null,
    workflowSummary: (pack) => pack,
    listCustomAgentIds: () => [],
    getOutputStyleStatusCached: () => ({ styles: [] }),
    seedOutputStyleStatusCache: () => {},
    scheduleOutputStyleSave: () => {},
    recreateCurrentSessionIfReady: async () => {},
    notifyFnForSession: () => () => {},
  });
  const modelApi = createModelRouteApi({
    ...shared,
    getConfigHasSecrets: () => true,
    getSearchRouteState: () => searchRouteState,
    setSearchRouteState: (value) => { searchRouteState = value; },
    statusRoutes: {},
    searchCapableFor: () => true,
    ensureFullConfig: () => config,
    awaitKeychainPrewarm: async () => {},
    persistLeadRoute: () => null,
    refreshRouteEffort: async () => {},
    refreshStatuslineUsageSnapshot: () => {},
    scheduleStatuslineUsageRefresh: () => {},
    invalidateProviderCaches: () => {},
    createCurrentSession: async () => {},
    invalidatePreSessionToolSurface: () => {},
    pushTranscriptRebind: () => {},
    collectSearchProviderModels: async () => [],
  });
  return { workflowApi, modelApi, diskWrites, getConfig: () => config };
}

test('agent route change preserves the Main model, effort and fast', async () => {
  const { workflowApi, diskWrites, getConfig } = harness();
  await workflowApi.setAgentRoute('worker', {
    provider: PROVIDER,
    model: MAIN_MODEL,
    effort: 'low',
    fast: false,
  });
  const config = getConfig();
  assert.deepEqual(config.modelSettings[MAIN_KEY], { effort: 'high', fast: true });
  assert.equal(diskWrites.length, 0);
  assert.equal(config.agents.worker.effort, 'low');
  const main = resolveRoute(config, {});
  assert.equal(main.provider, PROVIDER);
  assert.equal(main.model, MAIN_MODEL);
  assert.equal(main.effort, 'high');
  assert.equal(main.fast, true);
});

test('providerless raw Main selector uses the selected Main provider', () => {
  const resolveSelectedMainProvider = makeResolveDefaultProvider((provider) => provider === PROVIDER);
  const resolveSelectedMainRoute = makeResolveRoute(resolveSelectedMainProvider);
  const route = resolveSelectedMainRoute(baseConfig(), { model: 'replacement-main-model' });
  assert.equal(route.provider, PROVIDER);
  assert.equal(route.model, 'replacement-main-model');
});

test('agent route without an explicit effort does not inherit Main effort', async () => {
  const { workflowApi, getConfig } = harness();
  await workflowApi.setAgentRoute('worker', { provider: PROVIDER, model: 'claude-sonnet-4-5' });
  const worker = getConfig().agents.worker;
  assert.equal(worker.model, 'claude-sonnet-4-5');
  assert.equal(worker.effort, undefined);
  assert.equal(worker.fast, undefined);
});

test('agent route keeps its own effort when only the effort changes', async () => {
  const { workflowApi, getConfig } = harness();
  await workflowApi.setAgentRoute('worker', { provider: PROVIDER, model: MAIN_MODEL });
  assert.equal(getConfig().agents.worker.effort, 'medium');
});

test('providerless agent selection removes the override and inherits Main', async () => {
  const { workflowApi, getConfig } = harness();
  const inherited = await workflowApi.setAgentRoute('worker', { model: 'providerless-model' });
  assert.equal(inherited.inherited, true);
  assert.equal(inherited.provider, PROVIDER);
  assert.equal(inherited.model, MAIN_MODEL);
  assert.equal(getConfig().agents.worker, undefined);
});

test('onboarding model-only routes do not create overrides', async () => {
  const { workflowApi, getConfig } = harness();
  workflowApi.getOnboardingStatus = () => ({});
  await workflowApi.completeOnboarding({
    defaultProvider: PROVIDER,
    workflowRoutes: {
      agent: { model: 'claude-sonnet-4-5' },
    },
    searchRoute: { model: MAIN_MODEL },
  });
  const config = getConfig();
  assert.equal(config.agents.explore, undefined);
  assert.deepEqual(config.searchRoute, {
    provider: 'default',
    model: 'default',
  });
  assert.equal(config.defaultProvider, undefined);
});

test('providerless search selection stores follows-Main instead of reusing the old provider', async () => {
  const { modelApi, getConfig } = harness();
  const route = await modelApi.setSearchRoute({ model: 'ignored-providerless-model' });
  assert.deepEqual(route, { provider: 'default', model: 'default' });
  assert.deepEqual(getConfig().searchRoute, { provider: 'default', model: 'default' });
});

test('search route change preserves the Main model, effort and fast', async () => {
  const { modelApi, diskWrites, getConfig } = harness();
  await modelApi.setSearchRoute({ provider: PROVIDER, model: MAIN_MODEL, effort: 'low' });
  const config = getConfig();
  assert.deepEqual(config.modelSettings[MAIN_KEY], { effort: 'high', fast: true });
  assert.equal(diskWrites.length, 0);
  assert.equal(config.searchRoute.effort, 'low');
  const main = resolveRoute(config, {});
  assert.equal(main.model, MAIN_MODEL);
  assert.equal(main.effort, 'high');
  assert.equal(main.fast, true);
});
