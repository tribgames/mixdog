import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveModelSettings } from '../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import { createModelRouteApi } from './model-route-api.mjs';
import { makeResolveRoute } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';

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

test('an exact token window and a percentage replace each other in saved settings', () => {
  const cfgMod = { loadConfig: () => ({ modelSettings: {} }) };
  const route = { provider: 'openai', model: 'gpt-5.4', contextDefaultPercent: 50 };
  const saved = (next, setting) =>
    saveModelSettings(cfgMod, { ...route, ...next }, { baseConfig: { modelSettings: { 'openai/gpt-5.4': setting } } })
      .modelSettings['openai/gpt-5.4'];
  // Tokens win over a percent sent alongside and drop a stored percent.
  assert.deepEqual(saved({ contextTokens: 640_000, contextPercent: 60 }, { contextPercent: 30 }), {
    fast: false,
    contextTokens: 640_000,
  });
  // Choosing a percent drops stored tokens.
  assert.deepEqual(saved({ contextPercent: 70 }, { contextTokens: 640_000 }), { fast: false, contextPercent: 70 });
  // The default stop drops both.
  assert.deepEqual(saved({ contextPercent: 50 }, { contextTokens: 640_000 }), { fast: false });
});

test('route resolution loads saved tokens and lets a percent or tokens replace the other', () => {
  const resolveRoute = makeResolveRoute(() => 'openai');
  const config = (setting) => ({ modelSettings: { 'openai/gpt-5.4': setting } });
  const route = { provider: 'openai', model: 'gpt-5.4' };
  const tokensSaved = resolveRoute(config({ contextTokens: 640_000 }), route);
  assert.equal(tokensSaved.contextTokens, 640_000);
  assert.equal(tokensSaved.contextPercent, undefined);
  const percentChosen = resolveRoute(config({ contextTokens: 640_000 }), { ...route, contextPercent: 30 });
  assert.equal(percentChosen.contextPercent, 30);
  assert.equal(Object.hasOwn(percentChosen, 'contextTokens'), false);
  const tokensChosen = resolveRoute(config({ contextPercent: 30 }), { ...route, contextTokens: 700_000 });
  assert.equal(tokensChosen.contextTokens, 700_000);
  assert.equal(tokensChosen.contextPercent, undefined);
  assert.equal(Object.hasOwn(resolveRoute(config({ contextPercent: 30 }), route), 'contextTokens'), false);
});

test('setRoute saves an exact window clamped and drops it at the default window', async () => {
  const run = async (requested, setting = {}) => {
    let saved = null;
    const api = stubRouteApi({
      cfgMod: { loadConfig: () => ({ modelSettings: {} }) },
      persistLeadRoute: () => null,
      saveConfigAndAdopt: (next) => {
        saved = next.modelSettings['openai/gpt-5.4'];
      },
      initialConfig: { modelSettings: { 'openai/gpt-5.4': setting } },
      // 500k default of a 1M window.
      lookupModelMeta: async (_provider, model) => ({ id: model, contextWindow: 1_000_000 }),
    });
    await api.setRoute({ provider: 'openai', model: 'gpt-5.4', ...requested });
    return saved;
  };
  assert.equal((await run({ contextTokens: 640_000 }, { contextPercent: 30 })).contextTokens, 640_000);
  assert.equal((await run({ contextTokens: 640_000 }, { contextPercent: 30 })).contextPercent, undefined);
  assert.equal((await run({ contextTokens: 5_000 })).contextTokens, 100_000);
  assert.equal((await run({ contextTokens: 9_000_000 })).contextTokens, 1_000_000);
  const atDefault = await run({ contextTokens: 500_000 }, { contextTokens: 640_000 });
  assert.equal(Object.hasOwn(atDefault, 'contextTokens'), false);
  assert.equal(Object.hasOwn(atDefault, 'contextPercent'), false);
  const percent = await run({ contextPercent: 70 }, { contextTokens: 640_000 });
  assert.equal(percent.contextPercent, 70);
  assert.equal(Object.hasOwn(percent, 'contextTokens'), false);
});

// `main` is the route a new task resolves to; it defaults to the live route.
function stubRouteApi({
  persistLeadRoute,
  saveConfigAndAdopt,
  cfgMod,
  main,
  session = null,
  initialRoute,
  initialConfig = { modelSettings: {} },
  lookupModelMeta = async (_provider, model) => ({ id: model }),
}) {
  let config = initialConfig;
  let route = initialRoute || { provider: 'openai', model: 'gpt-5.4', effort: 'high', fast: false };
  return createModelRouteApi({
    getConfig: () => config,
    getRoute: () => route,
    setRouteState: (next) => {
      route = next;
    },
    getSession: () => session,
    getSessionGeneration: () => 0,
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
    lookupModelMeta,
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
  // Only an explicit default selection changes the main model.
  assert.deepEqual(await run(astra, (api) => api.setRoute({ provider: 'openai', model: 'gpt-6-astra' })), {
    persisted: [],
    debounceCalls: 1,
  });
  assert.deepEqual(
    await run(astra, (api) => api.setRoute({ provider: 'openai', model: 'gpt-6-astra' }, { keepMainModel: false })),
    {
      persisted: ['gpt-6-astra'],
      debounceCalls: 0,
    }
  );
  assert.deepEqual(
    await run(astra, (api) => api.setRoute({ provider: 'openai', model: 'gpt-5.4' }, { keepMainModel: false })),
    {
      persisted: ['gpt-5.4'],
      debounceCalls: 0,
    }
  );
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

test('tuning never changes the Main model: empty live route writes no preset, a pick during tuning is kept', async () => {
  const { normalizeWorkflowRoute } = await import('../runtime/agent/orchestrator/runtime-core/workflow.mjs');
  const persisted = [];
  const persistLeadRoute = (route) => {
    const lead = normalizeWorkflowRoute(route);
    if (lead) persisted.push(lead.model);
    return lead;
  };
  const stub = (extra) =>
    stubRouteApi({
      cfgMod: { loadConfig: () => ({ modelSettings: {} }) },
      persistLeadRoute,
      saveConfigAndAdopt: () => {},
      ...extra,
    });
  // No model on the live route: tuning has nothing to write as the Main model.
  const empty = stub({ initialRoute: { provider: '', model: '' } });
  await empty.setEffort('low');
  assert.deepEqual(persisted, []);
  // A model picked while a tuning waits for the model metadata stays: tuning
  // reads the live route afterwards and only ever rewrites the Main model with itself.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let holdNext = true;
  const picked = { provider: 'openai', model: 'gpt-6-sol' };
  const api = stub({
    lookupModelMeta: async (_provider, model) => {
      if (holdNext) {
        holdNext = false;
        await gate;
      }
      return { id: model };
    },
  });
  const tuning = api.setEffort('low');
  await Promise.resolve();
  await api.setRoute(picked, { keepMainModel: false });
  release();
  await tuning;
  // (This stub resolves the lead preset id as a literal model; real resolution maps it back.)
  assert.deepEqual(
    [...new Set(persisted)].filter((model) => model !== 'workflow-lead'),
    ['gpt-6-sol']
  );
});
