import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveModelSettings } from './model-capabilities.mjs';
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
  const next = saveModelSettings(cfgMod, {
    provider: 'openai',
    model: 'gpt-5.4',
    effort: 'high',
    fast: true,
    modelParameters: { context: '1m' },
    contextPercent: 70,
  }, { fastCapable: true, baseConfig: cfgMod.loadConfig() });
  assert.equal(saveCalls, 0);
  assert.deepEqual(next.modelSettings['openai/gpt-5.4'], {
    effort: 'high',
    fast: true,
    modelParameters: { context: '1m' },
    contextPercent: 70,
  });
  assert.equal(next.fastModels, undefined);
});

function stubRouteApi({ persistLeadRoute, saveConfigAndAdopt, cfgMod }) {
  let config = { modelSettings: {} };
  let route = { provider: 'openai', model: 'gpt-5.4', effort: 'high', fast: false };
  return createModelRouteApi({
    getConfig: () => config,
    getRoute: () => route,
    setRouteState: (next) => { route = next; },
    getSession: () => null,
    setSession: () => {},
    getConfigHasSecrets: () => false,
    getSearchRouteState: () => null,
    setSearchRouteState: () => {},
    cfgMod,
    reg: {},
    mgr: {},
    statusRoutes: {},
    resolveRoute: (_cfg, requested) => ({ ...route, ...requested }),
    searchCapableFor: () => false,
    lookupModelMeta: async () => ({ id: 'gpt-5.4' }),
    adoptConfig: (next) => { config = next; return next; },
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
    collectSearchProviderModels: async () => [],
  });
}

test('setFast persists through the debounce path, never cfgMod.saveConfig', async () => {
  let saveCalls = 0;
  let persistLeadCalls = 0;
  let debounceCalls = 0;
  const api = stubRouteApi({
    cfgMod: {
      loadConfig() { return { modelSettings: {} }; },
      saveConfig() { saveCalls += 1; },
    },
    persistLeadRoute: (route) => {
      persistLeadCalls += 1;
      return { provider: route.provider, model: route.model };
    },
    saveConfigAndAdopt: () => { debounceCalls += 1; },
  });
  await api.setFast(true);
  assert.equal(saveCalls, 0);
  assert.equal(persistLeadCalls, 1);
  assert.equal(debounceCalls, 0);
});

test('setFast debounce-persists modelSettings when the lead preset cannot be written', async () => {
  let saveCalls = 0;
  let debounceCalls = 0;
  const api = stubRouteApi({
    cfgMod: {
      loadConfig() { return { modelSettings: {} }; },
      saveConfig() { saveCalls += 1; },
    },
    persistLeadRoute: () => null,
    saveConfigAndAdopt: () => { debounceCalls += 1; },
  });
  await api.setFast(true);
  assert.equal(saveCalls, 0);
  assert.equal(debounceCalls, 1);
});
