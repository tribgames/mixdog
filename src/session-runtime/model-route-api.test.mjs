import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelRouteApi } from './model-route-api.mjs';
import { WEB_SEARCH_DEFAULT_MODEL, WEB_SEARCH_DEFAULT_PROVIDER } from './workflow.mjs';

const sourceRoute = { provider: 'openai', model: 'gpt-5.4', effort: 'high', fast: false };

function fixture({ session, updateSessionRoute, lookupModelMeta } = {}) {
  let config = { modelSettings: {} };
  const calls = [];
  const state = {
    route: { ...sourceRoute, contextPercent: 100, effectiveEffort: 'high' },
    session: session === undefined ? { id: 'empty-1', ...sourceRoute, messages: [] } : session,
    webSearchRoute: null,
  };
  const api = createModelRouteApi({
    getConfig: () => config,
    getConfigHasSecrets: () => false,
    getRoute: () => state.route,
    setRouteState: (value) => {
      state.route = value;
    },
    getSession: () => state.session,
    setSession: (value) => {
      calls.push(['setSession', value?.id ?? null]);
      state.session = value;
    },
    getWebSearchRouteState: () => state.webSearchRoute,
    setWebSearchRouteState: (next) => {
      state.webSearchRoute = next;
    },
    cfgMod: { loadConfig: () => config },
    resolveRoute: (_config, requested) => ({ ...state.route, ...requested }),
    lookupModelMeta: lookupModelMeta || (async (_provider, model) => ({ id: model, fastCapable: true })),
    webSearchCapableFor: () => true,
    ensureProvidersReady: async () => {},
    awaitKeychainPrewarm: async () => {},
    ensureFullConfig: () => config,
    adoptConfig: (value) => {
      config = value;
    },
    persistLeadRoute: () => null,
    saveConfigAndAdopt: (value) => {
      config = value;
    },
    refreshRouteEffort: async () => {
      state.route = { ...state.route, effectiveEffort: state.route.effort };
    },
    refreshStatuslineUsageSnapshot() {},
    scheduleStatuslineUsageRefresh() {},
    invalidateContextStatusCache: () => calls.push(['invalidateContextStatusCache']),
    invalidateProviderCaches: () => calls.push(['invalidateProviderCaches']),
    invalidatePreSessionToolSurface: () => calls.push(['invalidatePreSessionToolSurface']),
    createCurrentSession: async (reason) => {
      calls.push(['createCurrentSession', reason]);
      if (reason === 'model-switch-empty') state.session = { id: 'empty-2', ...state.route, messages: [] };
    },
    collectWebSearchProviderModels: async (opts) => {
      calls.push(['collectWebSearchProviderModels', opts]);
      return ['m1'];
    },
    statusRoutes: { clearGatewaySessionRoute: (id) => calls.push(['clearGatewaySessionRoute', id]) },
    mgr: {
      closeSession: (id, reason, opts) => calls.push(['closeSession', id, reason, opts]),
      updateSessionRoute:
        updateSessionRoute ||
        ((_id, next) => {
          Object.assign(state.session, next);
          return state.session;
        }),
    },
  });
  return { api, state, calls, getConfig: () => config };
}

test('setRoute on an empty session without an explicit address recreates the session for the new route', async () => {
  const { api, state, calls } = fixture();
  const route = await api.setRoute({ provider: 'anthropic', model: 'claude-x' });
  assert.equal(route.model, 'claude-x');
  assert.deepEqual(calls, [
    ['createCurrentSession', 'model-switch-empty-drain'],
    ['clearGatewaySessionRoute', 'empty-1'],
    ['closeSession', 'empty-1', 'cli-model-switch-empty', { tombstone: true }],
    ['setSession', null],
    ['invalidatePreSessionToolSurface'],
    ['createCurrentSession', 'model-switch-empty'],
    ['invalidateContextStatusCache'],
  ]);
  assert.equal(state.session.id, 'empty-2');
});

test('setRoute on an addressed empty session updates it in place through the manager', async () => {
  const { api, state, calls } = fixture();
  await api.setRoute({ provider: 'anthropic', model: 'claude-x' }, { applyToCurrentSession: true });
  assert.equal(state.session.id, 'empty-1');
  assert.equal(state.session.model, 'claude-x');
  assert.equal(state.session.provider, 'anthropic');
  assert.ok(!calls.some(([name]) => name === 'createCurrentSession' || name === 'closeSession'));
  assert.deepEqual(calls.at(-1), ['invalidateContextStatusCache']);
});

test('setRoute falls back to mutating the session when the manager cannot update it', async () => {
  const { api, state } = fixture({ updateSessionRoute: () => null });
  await api.setRoute({ provider: 'anthropic', model: 'claude-x', effort: 'low' }, { applyToCurrentSession: true });
  assert.equal(state.session.model, 'claude-x');
  assert.equal(state.session.effort, 'low');
  assert.deepEqual(state.session.modelParameters, {});
});

test('setRoute rejects a model the provider catalog cannot resolve', async () => {
  const { api } = fixture({ lookupModelMeta: async (_provider, model) => ({ id: model }) });
  await assert.rejects(
    () => api.setRoute({ model: 'gpt-9.9-nonexistent-zz' }),
    /unknown model: openai\/gpt-9.9-nonexistent-zz/
  );
});

test('setWebSearchRoute with an empty provider resets to the default route and keeps toolType', async () => {
  const { api, getConfig, calls } = fixture();
  const saved = await api.setWebSearchRoute({ provider: '', toolType: 'preview' });
  assert.deepEqual(saved, {
    provider: WEB_SEARCH_DEFAULT_PROVIDER,
    model: WEB_SEARCH_DEFAULT_MODEL,
    toolType: 'preview',
  });
  assert.deepEqual(getConfig().webSearchRoute, saved);
  assert.deepEqual(api.getWebSearchRoute(), saved);
  assert.ok(calls.some(([name]) => name === 'invalidateProviderCaches'));
});

test('setWebSearchRoute refuses a provider without native web search', async () => {
  const { api } = fixture();
  await assert.rejects(
    () => api.setWebSearchRoute({ provider: 'not-a-search-provider', model: 'm' }),
    /does not support Mixdog native web search/
  );
});

test('listWebSearchModels forwards force/refresh as one force flag', async () => {
  const { api, calls } = fixture();
  assert.deepEqual(await api.listWebSearchModels({ refresh: true }), ['m1']);
  assert.deepEqual(await api.listWebSearchModels(), ['m1']);
  assert.deepEqual(
    calls.filter(([name]) => name === 'collectWebSearchProviderModels'),
    [
      ['collectWebSearchProviderModels', { force: true }],
      ['collectWebSearchProviderModels', { force: false }],
    ]
  );
});

test('toggleFast flips the route fast flag and reports the new value', async () => {
  const { api, state } = fixture();
  assert.equal(await api.toggleFast(), true);
  assert.equal(state.route.fast, true);
  assert.equal(await api.toggleFast(), false);
  assert.equal(state.route.fast, false);
});
