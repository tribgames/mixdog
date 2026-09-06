import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelRouteApi } from './model-route-api.mjs';
import { createContextStatus } from './context-status.mjs';
import { createRuntimeFacade } from './runtime-facade.mjs';
import { createContextState } from '../tui/session/context-state.mjs';
import { SUMMARY_PREFIX } from '../runtime/agent/orchestrator/session/compact.mjs';

const sourceRoute = { provider: 'openai', model: 'gpt-5.4', effort: 'high', fast: false };
const heirRoute = {
  provider: 'openai', model: 'gpt-5.3-codex', effort: 'low', fast: true,
  contextPercent: 70,
};

function fixture(extra = {}) {
  let config = { modelSettings: {} };
  const state = {
    route: { ...sourceRoute, contextPercent: 100, effectiveEffort: 'high' },
    session: {
      id: 'session-route-lock', ...sourceRoute,
      contextPercent: 100,
      contextWindow: 128_000, rawContextWindow: 128_000, compactBoundaryTokens: 128_000,
      compaction: { auto: true, boundaryTokens: 128_000 },
      messages: [{ role: 'user', content: 'Keep working on this task.' }],
      providerState: { continuation: 'source-provider' },
      ...extra,
    },
  };
  const api = createModelRouteApi({
    getConfig: () => config,
    getConfigHasSecrets: () => false,
    getRoute: () => state.route,
    setRouteState: (value) => { state.route = value; },
    getSession: () => state.session,
    setSession: (value) => { state.session = value; },
    cfgMod: { loadConfig: () => config },
    resolveRoute: (_config, requested) => ({ ...state.route, ...requested }),
    lookupModelMeta: async (_provider, model) => ({ id: model, fastCapable: true }),
    ensureProvidersReady: async () => {},
    adoptConfig: (value) => { config = value; },
    persistLeadRoute: () => null,
    saveConfigAndAdopt: (value) => { config = value; },
    refreshRouteEffort: async () => {
      state.route = { ...state.route, effectiveEffort: state.route.effort, selectedContextWindow: 512_000 };
    },
    refreshStatuslineUsageSnapshot() {},
    scheduleStatuslineUsageRefresh() {},
    invalidateContextStatusCache() {},
    statusRoutes: {},
    mgr: {
      updateSessionRoute(_id, next) {
        Object.assign(state.session, next, {
          contextWindow: 512_000, rawContextWindow: 512_000, compactBoundaryTokens: 512_000,
        });
        return state.session;
      },
    },
  });
  return { api, state };
}

for (const [name, extra] of [
  ['established', {}],
  ['first in-flight turn', { messages: [], liveTurnMessages: [{ role: 'user', content: 'First task' }] }],
  ['compacted', { messages: [{ role: 'user', content: `${SUMMARY_PREFIX}\nRetained task` }] }],
]) {
  test(`${name} conversation keeps model, context and provider state until inheritance`, async () => {
    const { api, state } = fixture(extra);
    const before = structuredClone(state.session);
    await api.setRoute(heirRoute, { applyToCurrentSession: true });
    assert.equal(state.route.model, heirRoute.model, 'the heir selection is retained');
    assert.deepEqual(state.session, before, 'explicit addressing cannot rewrite the source');
    await api.setEffort('medium');
    await api.setFast(false);
    assert.deepEqual(state.session, before, 'heir tuning cannot leak into the source model');
  });
}

test('effort and Fast update the current model without touching its context or cache', async () => {
  const { api, state } = fixture();
  await api.setEffort('low');
  await api.setFast(true);
  assert.equal(state.session.effort, 'low');
  assert.equal(state.session.fast, true);
  const before = structuredClone(state.session);
  await api.setRoute({
    ...sourceRoute, effort: 'medium', fast: false, contextPercent: 50,
  }, { applyToCurrentSession: true });
  assert.deepEqual(state.session, { ...before, effort: 'medium', fast: false });
});

test('an addressed empty heir can choose a model without changing its durable id', async () => {
  const { api, state } = fixture({ messages: [] });
  await api.setRoute(heirRoute, { applyToCurrentSession: true });
  assert.equal(state.session.id, 'session-route-lock');
  assert.equal(state.session.model, heirRoute.model);
  assert.equal(state.session.contextWindow, 512_000);
});

test('heir selection leaves the source context gauge and compact trigger unchanged', async () => {
  const { api, state } = fixture({ tools: [] });
  const contextApi = createContextStatus({
    getSession: () => state.session,
    getRoute: () => state.route,
    getCurrentCwd: () => process.cwd(),
    getMode: () => 'full',
  });
  const runtime = createRuntimeFacade({
    state, getContextStatus: contextApi.contextStatus,
    getAutoClear: () => ({}), getSystemShell: () => ({}),
    getWebSearchRoute: () => null, getWorkflow: () => null,
  });
  let display = {
    sessionId: state.session.id, clientHostPid: process.pid,
    ...sourceRoute, contextWindow: 128_000, rawContextWindow: 128_000,
    displayContextWindow: 128_000, compactBoundaryTokens: 128_000, autoCompactTokenLimit: 115_200,
  };
  const { routeState } = createContextState({
    runtime, getState: () => display,
    updateState: (patch) => { display = { ...display, ...patch }; },
    getPendingSessionReset: () => false,
  });
  const before = contextApi.contextStatus();
  await api.setRoute(heirRoute, { applyToCurrentSession: true });
  const after = contextApi.contextStatus();
  assert.equal(after.model, sourceRoute.model);
  assert.equal(after.provider, sourceRoute.provider);
  assert.equal(after.contextWindow, before.contextWindow);
  assert.equal(after.compaction.triggerTokens, before.compaction.triggerTokens);
  assert.equal(after.usedTokens, before.usedTokens);
  const next = routeState();
  assert.equal(next.model, heirRoute.model);
  assert.equal(next.contextPercent, heirRoute.contextPercent);
  assert.equal(next.displayContextWindow, display.displayContextWindow);
  assert.equal(next.autoCompactTokenLimit, display.autoCompactTokenLimit);
});
