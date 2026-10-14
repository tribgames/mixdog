import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelRouteApi } from './model-route-api.mjs';
import { createContextStatus } from '../runtime/agent/orchestrator/runtime-core/context-status.mjs';
import { createRuntimeFacade } from './runtime-facade.mjs';
import { createContextState } from '../tui/session/context-state.mjs';
import { SUMMARY_PREFIX } from '../runtime/agent/orchestrator/session/compact.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';

const sourceRoute = { provider: 'openai', model: 'gpt-5.4', effort: 'high', fast: false };
const heirRoute = {
  provider: 'openai',
  model: 'gpt-5.3-codex',
  effort: 'low',
  fast: true,
  contextPercent: 70,
};

function fixture(extra = {}) {
  let config = { modelSettings: {} };
  const routeUpdates = [];
  const state = {
    route: { ...sourceRoute, contextPercent: 100, effectiveEffort: 'high' },
    session: {
      id: 'session-route-lock',
      ...sourceRoute,
      contextPercent: 100,
      contextWindow: 128_000,
      rawContextWindow: 128_000,
      compactBoundaryTokens: 128_000,
      compaction: { auto: true, boundaryTokens: 128_000 },
      messages: [
        { role: 'user', content: 'Keep working on this task.' },
        { role: 'assistant', content: 'Working on it.' },
      ],
      providerState: { continuation: 'source-provider' },
      ...extra,
    },
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
      state.session = value;
    },
    cfgMod: { loadConfig: () => config },
    resolveRoute: (_config, requested) => ({ ...state.route, ...requested }),
    lookupModelMeta: async (_provider, model) => ({ id: model, fastCapable: true }),
    ensureProvidersReady: async () => {},
    adoptConfig: (value) => {
      config = value;
    },
    persistLeadRoute: () => null,
    saveConfigAndAdopt: (value) => {
      config = value;
    },
    refreshRouteEffort: async () => {
      state.route = { ...state.route, effectiveEffort: state.route.effort, selectedContextWindow: 512_000 };
    },
    refreshStatuslineUsageSnapshot() {},
    scheduleStatuslineUsageRefresh() {},
    invalidateContextStatusCache() {},
    statusRoutes: {},
    mgr: {
      updateSessionRoute(_id, next, options) {
        routeUpdates.push(options ?? null);
        Object.assign(state.session, next, {
          contextWindow: 512_000,
          rawContextWindow: 512_000,
          compactBoundaryTokens: 512_000,
        });
        return state.session;
      },
    },
  });
  return { api, state, routeUpdates };
}

for (const [name, extra] of [
  ['established', {}],
  ['first in-flight turn', { messages: [], liveTurnMessages: [{ role: 'user', content: 'First task' }] }],
  ['compacted', { messages: [{ role: 'user', content: `${SUMMARY_PREFIX}\nRetained task` }] }],
]) {
  test(`${name} conversation keeps model, context and provider state for an unaddressed selection`, async () => {
    const { api, state } = fixture(extra);
    const before = structuredClone(state.session);
    await api.setRoute(heirRoute);
    assert.equal(state.route.model, heirRoute.model, 'the selection is retained for new sessions');
    assert.deepEqual(state.session, before, 'only an addressed selection rewrites the conversation');
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
  await api.setRoute(
    {
      ...sourceRoute,
      effort: 'medium',
      fast: false,
      contextPercent: 50,
    },
    { applyToCurrentSession: true }
  );
  assert.deepEqual(state.session, { ...before, effort: 'medium', fast: false });
});

test('an addressed empty heir can choose a model without changing its durable id', async () => {
  const { api, state } = fixture({ messages: [] });
  await api.setRoute(heirRoute, { applyToCurrentSession: true });
  assert.equal(state.session.id, 'session-route-lock');
  assert.equal(state.session.model, heirRoute.model);
  assert.equal(state.session.contextWindow, 512_000);
});

test('a conversation whose prompts were refused before any reply follows the new model in place', async () => {
  const refused = [{ role: 'user', content: 'First task' }];
  const { api, state } = fixture({ messages: refused });
  await api.setRoute(heirRoute, { applyToCurrentSession: true });
  assert.equal(state.session.id, 'session-route-lock');
  assert.equal(state.session.model, heirRoute.model);
  assert.deepEqual(state.session.messages, refused, 'the refused prompt is kept for retry');
});

test('an unaddressed selection leaves the session context gauge and compact trigger unchanged', async () => {
  const { api, state } = fixture({ tools: [] });
  const contextApi = createContextStatus({
    getSession: () => state.session,
    getRoute: () => state.route,
    getCurrentCwd: () => process.cwd(),
    getMode: () => 'full',
  });
  const runtime = createRuntimeFacade({
    state,
    getContextStatus: contextApi.contextStatus,
    getAutoClear: () => ({}),
    getSystemShell: () => ({}),
    getWebSearchRoute: () => null,
    getWorkflow: () => null,
    getOrchestrationMode: () => 'none',
  });
  let display = {
    sessionId: state.session.id,
    clientHostPid: process.pid,
    ...sourceRoute,
    contextWindow: 128_000,
    rawContextWindow: 128_000,
    displayContextWindow: 128_000,
    compactBoundaryTokens: 128_000,
    autoCompactTokenLimit: 115_200,
  };
  const { routeState } = createContextState({
    runtime,
    getState: () => display,
    updateState: (patch) => {
      display = { ...display, ...patch };
    },
    getPendingSessionReset: () => false,
  });
  const before = contextApi.contextStatus();
  await api.setRoute(heirRoute);
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

test('snapshot sessionProvider/sessionModel track the session route, not the selected route', async () => {
  const build = (state) => {
    const runtime = createRuntimeFacade({
      state,
      getContextStatus: () => ({}),
      getAutoClear: () => ({}),
      getSystemShell: () => ({}),
      getWebSearchRoute: () => null,
      getWorkflow: () => null,
      getOrchestrationMode: () => 'none',
    });
    let display = {};
    return createContextState({
      runtime,
      getState: () => display,
      updateState: (patch) => {
        display = { ...display, ...patch };
      },
      getPendingSessionReset: () => false,
    }).routeState;
  };
  const history = fixture();
  const historyState = build(history.state);
  await history.api.setRoute(heirRoute);
  const kept = historyState();
  assert.equal(kept.model, heirRoute.model);
  assert.equal(kept.sessionModel, sourceRoute.model);
  assert.equal(kept.sessionProvider, sourceRoute.provider);
  assert.notEqual(kept.sessionModel, kept.model);

  const empty = fixture({ messages: [] });
  const emptyState = build(empty.state);
  await empty.api.setRoute(heirRoute, { applyToCurrentSession: true });
  assert.equal(emptyState().sessionModel, heirRoute.model);
});

test('continueSessionInModel moves an established session in place', async () => {
  const { api, state } = fixture();
  const result = await api.continueSessionInModel('session-route-lock', heirRoute);
  // The same boundary setRoute answers, so the surface shows the live divider.
  assert.deepEqual(result.modelSwitch, { provider: heirRoute.provider, modelId: heirRoute.model, at: result.modelSwitch.at });
  assert.deepEqual(state.session.messages.at(-1).meta.modelSwitches, [result.modelSwitch]);
  assert.equal(state.session.id, 'session-route-lock');
  assert.equal(state.session.model, heirRoute.model);
  assert.equal(state.session.effort, 'low');
  assert.equal(state.route.model, heirRoute.model);
  assert.equal(state.session.contextWindow, 512_000);
});

test('continueSessionInModel rejects a session that is not the addressed one', async () => {
  const { api, state } = fixture();
  await assert.rejects(api.continueSessionInModel('other-session', heirRoute), /not the active session/);
  assert.equal(state.session.model, sourceRoute.model);
});

const crossRoute = { provider: 'anthropic', model: 'claude-x', effort: 'low', fast: false };

test('an addressed selection of another model switches the established conversation in place', async () => {
  const { api, state, routeUpdates } = fixture();
  const messages = structuredClone(state.session.messages);
  const result = await api.setRoute(crossRoute, { applyToCurrentSession: true });
  assert.equal(state.session.id, 'session-route-lock', 'the same chat, not a new session');
  assert.equal(state.session.provider, 'anthropic', 'cross-provider');
  assert.equal(state.session.model, 'claude-x');
  assert.equal(state.session.effort, 'low');
  assert.equal(state.session.contextWindow, 512_000);
  assert.deepEqual(routeUpdates, [{ crossProvider: true }], 'the old provider replay and readings are dropped');
  assert.deepEqual(
    state.session.messages.map(({ role, content }) => ({ role, content })),
    messages.map(({ role, content }) => ({ role, content })),
    'the conversation itself is untouched'
  );
  // The selected route and the chat's own route are equal afterwards.
  assert.equal(state.route.provider, state.session.provider);
  assert.equal(state.route.model, state.session.model);
  assert.deepEqual(result.modelSwitch, {
    provider: 'anthropic',
    modelId: 'claude-x',
    at: result.modelSwitch.at,
  });
  // A display-only boundary on the last message, restored after the answer.
  const boundary = state.session.messages.at(-1).meta.modelSwitches;
  assert.deepEqual(boundary, [result.modelSwitch]);
  const items = restoreTranscriptItems(state.session.messages, { sessionId: state.session.id });
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'assistant', 'statusdone']
  );
  assert.equal(items.at(-1).status, 'model-switched');
  assert.equal(items.at(-1).provider, 'anthropic');
  assert.equal(items.at(-1).modelId, 'claude-x');
  assert.equal(restoreTranscriptItems(state.session.messages, { itemLimit: 1 })[0].status, 'model-switched');
});

test('a switch after a stopped turn keeps its boundary off the unanswered prompt a retry rewinds', async () => {
  const { api, state } = fixture({
    messages: [
      { role: 'user', content: 'First.' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Stopped on quota.' },
    ],
  });
  const { modelSwitch } = await api.setRoute(crossRoute, { applyToCurrentSession: true });
  assert.deepEqual(state.session.messages[1].meta.modelSwitches, [modelSwitch]);
  assert.equal(state.session.messages[2].meta, undefined);
});

test("the session surface's user choice switches an established conversation; an empty one keeps the unaddressed rules", async () => {
  const { api, state, routeUpdates } = fixture();
  const result = await api.setRoute(crossRoute, { switchEstablished: true });
  assert.equal(state.session.id, 'session-route-lock');
  assert.equal(state.session.model, 'claude-x');
  assert.deepEqual(routeUpdates, [{ crossProvider: true }]);
  assert.deepEqual(state.session.messages.at(-1).meta.modelSwitches, [result.modelSwitch]);

  // An empty, unaddressed session without a recreate hook is updated in
  // place exactly as an unaddressed selection did before.
  const empty = fixture({ messages: [] });
  const emptyResult = await empty.api.setRoute(crossRoute, { switchEstablished: true });
  assert.equal(empty.state.session.model, 'claude-x');
  assert.equal(emptyResult.modelSwitch, undefined, 'nothing to mark');
});

test('an addressed same-model selection only tunes the conversation and records no switch', async () => {
  const { api, state, routeUpdates } = fixture();
  const result = await api.setRoute({ ...sourceRoute, effort: 'low' }, { applyToCurrentSession: true });
  assert.equal(result.modelSwitch, undefined);
  assert.deepEqual(routeUpdates, []);
  assert.equal(state.session.effort, 'low');
  assert.equal(
    state.session.messages.some((message) => message.meta?.modelSwitches),
    false
  );
});
