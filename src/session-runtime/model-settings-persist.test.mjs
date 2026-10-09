import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveModelSettings } from '../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import { createModelRouteApi } from './model-route-api.mjs';

test('saveModelSettings updates modelSettings without a sync config write', () => {
  let saveCalls = 0;
  const cfgMod = {
    loadConfig() {
      return { modelSettings: {} };
    },
    saveConfig() {
      saveCalls += 1;
    },
  };
  const next = saveModelSettings(
    cfgMod,
    {
      provider: 'openai',
      model: 'gpt-5.4',
      effort: 'high',
      fast: true,
      modelParameters: { context: '1m' },
      contextPercent: 70,
    },
    { fastCapable: true, baseConfig: cfgMod.loadConfig() }
  );
  assert.equal(saveCalls, 0);
  assert.deepEqual(next.modelSettings['openai/gpt-5.4'], {
    effort: 'high',
    fast: true,
    modelParameters: { context: '1m' },
    contextPercent: 70,
  });
  assert.equal(next.fastModels, undefined);
});

test('a window left at the model default is not stored as a setting', () => {
  const cfgMod = { loadConfig: () => ({ modelSettings: {} }) };
  const route = { provider: 'anthropic-oauth', model: 'claude-opus-5-5', effort: 'high', contextDefaultPercent: 50 };
  const saved = (contextPercent, baseConfig = cfgMod.loadConfig()) =>
    saveModelSettings(cfgMod, { ...route, contextPercent }, { baseConfig }).modelSettings[
      'anthropic-oauth/claude-opus-5-5'
    ];
  assert.equal(saved(50).contextPercent, undefined);
  assert.equal(saved(100).contextPercent, 100);
  // Returning to the default drops an earlier choice.
  const chosen = { modelSettings: { 'anthropic-oauth/claude-opus-5-5': { effort: 'high', contextPercent: 100 } } };
  assert.equal(saved(50, chosen).contextPercent, undefined);
  // A route that does not know its default keeps the stated percentage.
  const unknown = saveModelSettings(
    cfgMod,
    { provider: 'openai', model: 'gpt-5.4', contextPercent: 30 },
    { baseConfig: cfgMod.loadConfig() }
  );
  assert.equal(unknown.modelSettings['openai/gpt-5.4'].contextPercent, 30);
});

// `main` is the route a new task resolves to; it defaults to the live route.
function stubRouteApi({ persistLeadRoute, saveConfigAndAdopt, cfgMod, main, session = null, initialRoute }) {
  let config = { modelSettings: {} };
  let route = initialRoute || { provider: 'openai', model: 'gpt-5.4', effort: 'high', fast: false };
  return createModelRouteApi({
    getConfig: () => config,
    getRoute: () => route,
    setRouteState: (next) => {
      route = next;
    },
    getSession: () => session,
    setSession: () => {},
    getConfigHasSecrets: () => false,
    getWebSearchRouteState: () => null,
    setWebSearchRouteState: () => {},
    cfgMod,
    reg: {},
    mgr: {},
    statusRoutes: {},
    resolveRoute: (_cfg, requested) => (Object.keys(requested).length ? { ...route, ...requested } : (main ?? route)),
    webSearchCapableFor: () => false,
    lookupModelMeta: async (_provider, model) => ({ id: model }),
    adoptConfig: (next) => {
      config = next;
      return next;
    },
    saveConfigAndAdopt,
    ensureFullConfig: () => config,
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    persistLeadRoute,
    refreshRouteEffort: async () => {},
    refreshStatuslineUsageSnapshot: () => {},
    scheduleStatuslineUsageRefresh: () => {},
    invalidateContextStatusCache: () => {},
    invalidateProviderCaches: () => {},
    createCurrentSession: async () => {},
    invalidatePreSessionToolSurface: () => {},
    collectWebSearchProviderModels: async () => [],
  });
}

test('setFast syncs ultrafast into the active session parameters and removes it again', async () => {
  const session = { provider: 'openai', model: 'gpt-6-astra', modelParameters: { temperature: 0.2 } };
  const api = stubRouteApi({
    cfgMod: { loadConfig: () => ({ modelSettings: {} }) },
    persistLeadRoute: () => null,
    saveConfigAndAdopt: () => {},
    session,
    initialRoute: { provider: 'openai', model: 'gpt-6-astra', effort: 'high', fast: false },
  });
  await api.setFast('ultrafast');
  assert.deepEqual(session.modelParameters, { temperature: 0.2, serviceTier: 'ultrafast' });
  assert.equal(session.fast, true);
  await api.setFast(true);
  assert.deepEqual(session.modelParameters, { temperature: 0.2 });
});

test('setFast persists through the debounce path, never cfgMod.saveConfig', async () => {
  let saveCalls = 0;
  let persistLeadCalls = 0;
  let debounceCalls = 0;
  const api = stubRouteApi({
    cfgMod: {
      loadConfig() {
        return { modelSettings: {} };
      },
      saveConfig() {
        saveCalls += 1;
      },
    },
    persistLeadRoute: (route) => {
      persistLeadCalls += 1;
      return { provider: route.provider, model: route.model };
    },
    saveConfigAndAdopt: () => {
      debounceCalls += 1;
    },
  });
  await api.setFast(true);
  assert.equal(saveCalls, 0);
  assert.equal(persistLeadCalls, 1);
  assert.equal(debounceCalls, 0);
});

test('only a model choice replaces the main model; tuning another live model keeps it', async () => {
  // The configured main model, whether or not a lead preset holds it.
  const astra = { provider: 'openai', model: 'gpt-6-astra' };
  // The live route runs openai/gpt-5.4 (e.g. a resumed conversation).
  const run = async (main, act) => {
    const persisted = [];
    let debounceCalls = 0;
    const api = stubRouteApi({
      cfgMod: { loadConfig: () => ({ modelSettings: {} }) },
      persistLeadRoute: (route) => {
        persisted.push(route.model);
        return { provider: route.provider, model: route.model };
      },
      saveConfigAndAdopt: () => {
        debounceCalls += 1;
      },
      main,
    });
    await act(api);
    return { persisted, debounceCalls };
  };
  const effort = (api) => api.setEffort('low');
  // Tuning a live model that is not the main model saves only its own settings.
  assert.deepEqual(await run(astra, effort), { persisted: [], debounceCalls: 1 });
  assert.deepEqual(await run(astra, (api) => api.setFast(true)), { persisted: [], debounceCalls: 1 });
  assert.deepEqual(await run(astra, (api) => api.setRoute({ provider: 'openai', model: 'gpt-5.4' })), {
    persisted: [],
    debounceCalls: 1,
  });
  // Tuning the main model itself keeps its preset current.
  assert.deepEqual(await run(undefined, effort), { persisted: ['gpt-5.4'], debounceCalls: 0 });
  // Choosing a different model makes it the main model.
  assert.deepEqual(await run(astra, (api) => api.setRoute({ provider: 'openai', model: 'gpt-6-astra' })), {
    persisted: ['gpt-6-astra'],
    debounceCalls: 0,
  });
  // An heir opening on its source's model never replaces the main model.
  const heir = (api) => api.setRoute({ provider: 'openai', model: 'gpt-6-sol' }, { keepMainModel: true });
  assert.deepEqual(await run(astra, heir), { persisted: [], debounceCalls: 1 });
});

test('setFast debounce-persists modelSettings when the lead preset cannot be written', async () => {
  let saveCalls = 0;
  let debounceCalls = 0;
  const api = stubRouteApi({
    cfgMod: {
      loadConfig() {
        return { modelSettings: {} };
      },
      saveConfig() {
        saveCalls += 1;
      },
    },
    persistLeadRoute: () => null,
    saveConfigAndAdopt: () => {
      debounceCalls += 1;
    },
  });
  await api.setFast(true);
  assert.equal(saveCalls, 0);
  assert.equal(debounceCalls, 1);
});
