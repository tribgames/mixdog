import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelRouteApi } from './model-route-api.mjs';
import {
  WEB_SEARCH_DEFAULT_MODEL,
  WEB_SEARCH_DEFAULT_PROVIDER,
} from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';

const sourceRoute = { provider: 'openai', model: 'gpt-5.4', effort: 'high', fast: false };

function fixture({
  session,
  updateSessionRoute,
  lookupModelMeta,
  config: initialConfig,
  route: initialRoute,
  persistLeadRoute = () => null,
} = {}) {
  let config = initialConfig || { modelSettings: {} };
  const calls = [];
  const persisted = [];
  const state = {
    route: initialRoute || { ...sourceRoute, contextPercent: 100, effectiveEffort: 'high' },
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
    getSessionGeneration: () => 0,
    setSession: (value) => {
      calls.push(['setSession', value?.id ?? null]);
      state.session = value;
    },
    getWebSearchRouteState: () => state.webSearchRoute,
    setWebSearchRouteState: (next) => {
      state.webSearchRoute = next;
    },
    cfgMod: { loadConfig: () => config },
    resolveRoute: (_config, requested) => {
      // The real resolver reads only the route's own fields.
      const { fallbacks: _chain, ...fields } = requested;
      const { fallbacks: _leaked, ...base } = state.route;
      return { ...base, ...fields };
    },
    lookupModelMeta: lookupModelMeta || (async (_provider, model) => ({ id: model, fastCapable: true })),
    webSearchCapableFor: () => true,
    ensureProvidersReady: async () => {},
    awaitKeychainPrewarm: async () => {},
    ensureFullConfig: () => config,
    adoptConfig: (value) => {
      config = value;
    },
    persistLeadRoute,
    saveConfigAndAdopt: (value) => {
      persisted.push(value);
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
  return { api, state, calls, persisted, getConfig: () => config };
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

test('setRoute onlyIfEmpty fills an empty route and never replaces a set one', async () => {
  const empty = fixture({ route: { provider: '', model: '' } });
  await empty.api.setRoute({ provider: 'anthropic', model: 'claude-x' }, { onlyIfEmpty: true });
  assert.equal(empty.state.route.model, 'claude-x');
  const set = fixture();
  const answer = await set.api.setRoute({ provider: 'anthropic', model: 'claude-x' }, { onlyIfEmpty: true });
  assert.equal(answer.model, 'gpt-5.4');
  assert.equal(set.state.route.model, 'gpt-5.4');
  assert.deepEqual(set.persisted, []);
});

// Every Lead-route writer is this runtime's setRoute, with these options: the
// model controls and the settings model editor / RouteEditorDialog (the plain
// desktop setModelRoute), a new-task submit and the setup tool
// (keepMainModel: false), TUI /model and other windows or a phone (the same
// daemon session surface).
const LEAD_WRITERS = {
  'desktop setModelRoute / TUI /model': {},
  'settings model editor, new-task submit, setup tool': { keepMainModel: false },
  'addressed pick with the Main model': { applyToCurrentSession: true, keepMainModel: false },
};

for (const [writer, options] of Object.entries(LEAD_WRITERS)) {
  test(`a Main route picked by ${writer} between the emptiness read and the write is not overwritten`, async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const h = fixture({
      route: { provider: '', model: '' },
      lookupModelMeta: async (_provider, model) => {
        if (model === 'claude-fill') await gate;
        return { id: model, fastCapable: true };
      },
    });
    const fill = h.api.setRoute({ provider: 'anthropic', model: 'claude-fill' }, { onlyIfEmpty: true });
    await Promise.resolve();
    // The pick lands while the fill is still resolving its model.
    await h.api.setRoute({ provider: 'openai', model: 'gpt-picked' }, options);
    release();
    const answer = await fill;
    assert.equal(h.state.route.model, 'gpt-picked');
    assert.equal(answer.model, 'gpt-picked');
  });
}

test('setRoute rejects a model the provider catalog cannot resolve', async () => {
  const { api } = fixture({ lookupModelMeta: async (_provider, model) => ({ id: model }) });
  await assert.rejects(
    () => api.setRoute({ model: 'gpt-9.9-nonexistent-zz' }),
    /unknown model: openai\/gpt-9.9-nonexistent-zz/
  );
});

test('a session-only route change leaves Main selection, defaults and per-model settings untouched', async () => {
  const before = {
    modelSettings: { 'openai/gpt-5.4': { effort: 'medium', fast: false } },
    default: 'lead',
    presets: [{ id: 'lead', provider: 'openai', model: 'gpt-5.4' }],
  };
  const session = { id: 'child-1', ...sourceRoute, messages: [{ role: 'assistant', content: 'hi' }] };
  const request = { provider: 'openai', model: 'gpt-5.4', effort: 'low', fast: true };
  const options = { switchEstablished: true, deferUntilNextTurn: true };

  const scoped = fixture({ session, config: before });
  await scoped.api.setRoute(request, { ...options, sessionOnly: true });
  assert.equal(scoped.getConfig(), before, 'config is neither replaced nor rewritten');
  assert.deepEqual(scoped.persisted, [], 'nothing is persisted, lead preset included');
  assert.equal(scoped.state.route.effort, 'low', 'the child runtime itself follows the request');
  assert.equal(scoped.state.route.fast, true);

  // Without the scope the same request rewrites the shared per-model bucket.
  const shared = fixture({ session, config: before });
  await shared.api.setRoute(request, options);
  const bucket = shared.getConfig().modelSettings['openai/gpt-5.4'];
  assert.equal(bucket.effort, 'low');
  assert.equal(bucket.fast, true);
  assert.ok(shared.persisted.length > 0);
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

test('the Lead editor saves fallbacks with the Lead route; a pick without them keeps the stored chain; [] clears', async () => {
  const saved = [];
  const stored = {
    id: 'workflow-lead',
    provider: 'openai',
    model: 'gpt-5.4',
    fallbacks: [{ provider: 'anthropic', model: 'claude-x' }],
  };
  const { api } = fixture({
    config: { modelSettings: {}, presets: [stored], default: 'workflow-lead' },
    persistLeadRoute: (route) => {
      saved.push(route);
      return null;
    },
  });
  await api.setRoute(
    { provider: 'openai', model: 'gpt-5.4', fallbacks: [{ provider: 'gemini', model: 'g-1' }] },
    { keepMainModel: false }
  );
  assert.deepEqual(
    saved[0].fallbacks.map(({ provider, model }) => [provider, model]),
    [['gemini', 'g-1']]
  );
  await api.setRoute({ provider: 'openai', model: 'gpt-5.4', effort: 'low' }, { keepMainModel: false });
  assert.deepEqual(
    saved[1].fallbacks.map(({ provider, model }) => [provider, model]),
    [['anthropic', 'claude-x']]
  );
  await api.setRoute({ provider: 'openai', model: 'gpt-5.4', fallbacks: [] }, { keepMainModel: false });
  assert.deepEqual(saved[2].fallbacks, []);
  // The same provider as the primary is refused, as for an agent.
  await assert.rejects(
    api.setRoute(
      { provider: 'openai', model: 'gpt-5.4', fallbacks: [{ provider: 'openai', model: 'other' }] },
      { keepMainModel: false }
    ),
    /duplicate route provider/
  );
  // A session's own pick never touches the Lead chain.
  await api.setRoute({ provider: 'openai', model: 'gpt-5.4' }, { keepMainModel: true });
  assert.equal(saved.length, 3);
});

test("Lead fallback entries are normalized by the agents' function: an unsupported fast flag is clamped, saved tuning kept", async () => {
  const saved = [];
  const { api } = fixture({
    persistLeadRoute: (route) => {
      saved.push(route);
      return null;
    },
    lookupModelMeta: async (_provider, model) => ({
      id: model,
      fastCapable: model === 'fast-ok',
      supportsFastMode: model === 'fast-ok',
    }),
  });
  await api.setRoute(
    {
      provider: 'openai',
      model: 'gpt-5.4',
      fallbacks: [
        { provider: 'anthropic', model: 'no-fast', fast: true, effort: 'low' },
        { provider: 'cursor-oauth', model: 'fast-ok', fast: true },
      ],
    },
    { keepMainModel: false }
  );
  const [noFast, fastOk] = saved[0].fallbacks;
  assert.equal(noFast.fast, false, 'fast is clamped off on a model that cannot do it');
  assert.equal(noFast.effort, 'low');
  assert.equal(fastOk.fast, true);
});
