// A selection belongs to the session generation it was enqueued under. These
// tests run the real surface, the real runtime route API and the real route
// refresh, and move the runtime to another session (a resume, or the first
// session after none) at each await point of each outcome. Whatever the
// selection was about to do, the new session's route, display and pending
// state must come out untouched and the command lock released.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelRouteApi } from '../../../session-runtime/model-route-api.mjs';
import { trackSessionGeneration } from '../../../session-runtime/model-route/route-ownership.mjs';
import { createRouteResolution } from '../../../session-runtime/route-resolution.mjs';
import { createSessionRouteApi } from './routes.mjs';

const source = { provider: 'openai', model: 'gpt-5.4', effort: 'high', fast: false };
const requestedModel = { provider: 'openai', model: 'gpt-5.3-codex' };
const resumedRoute = {
  provider: 'anthropic',
  model: 'claude-resumed',
  effort: 'low',
  fast: false,
  contextPercent: 100,
  effectiveEffort: 'low',
};

function sessionRecord(id) {
  return {
    id,
    ...source,
    contextPercent: 100,
    messages: [
      { role: 'user', content: 'Keep working.' },
      { role: 'assistant', content: 'Working.' },
    ],
  };
}

/** `origin`: the session held when selections are enqueued ('A', or 'none'
 *  during a reset interval). The transition installs B and publishes B's route. */
function build(origin) {
  const rt = {
    config: { providers: {}, modelSettings: {} },
    route: { ...source, contextPercent: 100, effectiveEffort: 'high' },
    session: origin === 'A' ? sessionRecord('A') : null,
  };
  trackSessionGeneration(rt);
  const sessionB = sessionRecord('B');
  const sessionBBefore = structuredClone(sessionB);
  const updates = [];
  const runtimeCalls = [];
  let ui = { ...rt.route, busy: false, commandBusy: false, items: [], stats: {} };
  let armed = null;
  let afterMetadata = false;

  const transition = () => {
    rt.session = sessionB;
    rt.route = resumedRoute;
    ui = { ...ui, ...resumedRoute };
  };
  const reach = (point) => {
    if (armed?.point !== point) return;
    const { fail } = armed;
    armed = null;
    transition();
    if (fail) throw new Error('boom');
  };
  // The transition runs in a microtask queued just before the awaited call
  // returns, so it lands between that call resolving and its caller continuing.
  const atReturn = (point) => queueMicrotask(() => reach(point));
  const ensureProvidersReady = async () => {
    await Promise.resolve();
    reach(afterMetadata ? 'refresh' : 'provider-readiness');
    atReturn(afterMetadata ? 'refresh-return' : 'provider-readiness-return');
  };
  const lookupModelMeta = async (_provider, model) => {
    await Promise.resolve();
    afterMetadata = true;
    reach('adopt');
    atReturn('adopt-lookup-return');
    return { id: model, fastCapable: true };
  };
  const routes = createRouteResolution({
    rt,
    collectProviderModels: async () => [],
    ensureProvidersReady,
    lookupModelMeta,
  });
  const routeApi = createModelRouteApi({
    getConfig: () => rt.config,
    getConfigHasSecrets: () => false,
    getRoute: () => rt.route,
    setRouteState: (value) => {
      rt.route = value;
    },
    getSession: () => rt.session,
    getSessionGeneration: () => rt.sessionGeneration,
    setSession: (value) => {
      rt.session = value;
    },
    cfgMod: { loadConfig: () => rt.config },
    resolveRoute: (_config, requested) => ({ ...rt.route, ...requested }),
    lookupModelMeta,
    ensureProvidersReady,
    refreshRouteEffort: routes.refreshRouteEffort,
    adoptConfig: (value) => {
      rt.config = value;
    },
    persistLeadRoute: () => null,
    saveConfigAndAdopt: (value) => {
      rt.config = value;
    },
    refreshStatuslineUsageSnapshot() {},
    // The last step of adopting, right before the adopt call itself returns.
    scheduleStatuslineUsageRefresh: () => atReturn('adopt-return'),
    invalidateContextStatusCache() {},
    statusRoutes: {},
    mgr: {
      updateSessionRoute(_id, next) {
        updates.push(next);
        Object.assign(rt.session, next);
        return rt.session;
      },
    },
  });
  const runtime = {
    ...routeApi,
    get session() {
      return rt.session;
    },
    get sessionGeneration() {
      return rt.sessionGeneration;
    },
    listPresets: () => [],
    setRoute: async (next, options) => {
      runtimeCalls.push(next);
      afterMetadata = false;
      const result = await routeApi.setRoute(next, options);
      reach('publish');
      return result;
    },
  };
  const bag = {
    runtime,
    getState: () => ui,
    set: (patch) => {
      ui = { ...ui, ...patch };
    },
    flushEmitImmediate() {},
    routeState: () => rt.route,
    syncContextStats() {},
    resetStats() {},
    resetStatsAndSyncContext() {},
    pushItem() {},
    nextId: () => 1,
  };
  const api = createSessionRouteApi(bag);
  return {
    api,
    rt,
    ui: () => ui,
    runtimeCalls,
    updates,
    sessionB,
    sessionBBefore,
    arm: (point, fail = false) => {
      armed = { point, fail };
    },
    applyPending: routeApi.applyPendingRoute,
    // Direct runtime selections that apply to the live session, not deferred.
    immediate: () => runtime.setRoute(requestedModel, { applyToCurrentSession: true, switchEstablished: true }),
    continueInModel: () => routeApi.continueSessionInModel('A', requestedModel),
  };
}

// Inside the awaited call, where it may also fail, and at the promise-return
// boundary, where the call has resolved but its caller has not continued.
const CALL_POINTS = ['provider-readiness', 'adopt', 'refresh', 'publish'];
const RETURN_POINTS = ['provider-readiness-return', 'adopt-lookup-return', 'refresh-return', 'adopt-return'];

// path -> how the selection reaches the transition, and what it ends as.
const PATHS = {
  // The selection itself is in flight when the transition arrives.
  success: { calls: 1 },
  // ...and fails once the transition has happened.
  failure: { calls: 1, fail: true },
  // Queued behind an in-flight write; it starts after the transition.
  dropped: { calls: 2 },
  // A session-only request that asks for nothing new, queued the same way.
  unchanged: { calls: 1 },
  // Applied straight to the live session rather than deferred.
  immediate: { calls: 1 },
  // The quota escape hatch, which switches the established session in place.
  continue: { calls: 0, needsSession: true },
};

for (const origin of ['A', 'none']) {
  for (const [path, spec] of Object.entries(PATHS)) {
    if (spec.needsSession && origin !== 'A') continue;
    // 'publish' follows a complete application to the selection's own
    // session, which is then legitimately updated; only the deferred surface
    // paths have a publish step that the transition can precede.
    const points = (spec.fail ? CALL_POINTS : [...CALL_POINTS, ...RETURN_POINTS]).filter(
      (point) => point !== 'publish' || !['immediate', 'continue'].includes(path)
    );
    for (const point of points) {
      test(`session transition at ${point} (${path} selection, enqueued with ${origin === 'A' ? 'a session' : 'no session'}) leaves the new session untouched`, async () => {
        const h = build(origin);
        h.arm(point, spec.fail === true);
        const first =
          path === 'immediate'
            ? h.immediate()
            : path === 'continue'
              ? h.continueInModel()
              : h.api.setRoute(requestedModel);
        const outcomes = [first];
        if (path === 'dropped') outcomes.push(h.api.setRoute({ provider: 'openai', model: 'gpt-5.2' }));
        if (path === 'unchanged') outcomes.push(h.api.setRoute({ fast: false, sessionOnly: true }));
        const settled = await Promise.allSettled(outcomes);
        if (spec.fail) {
          assert.equal(settled[0].status, 'rejected');
          assert.match(settled[0].reason.message, /boom/);
        } else {
          assert.deepEqual(
            settled.map((outcome) => outcome.status),
            outcomes.map(() => 'fulfilled')
          );
        }
        assert.equal(h.runtimeCalls.length, spec.calls, 'the scenario took the intended path');
        assert.equal(h.rt.route, resumedRoute, 'the new session route is the live route, untouched');
        assert.equal(h.rt.session, h.sessionB);
        assert.deepEqual(h.sessionB, h.sessionBBefore, 'the new session is untouched');
        assert.deepEqual(h.updates, []);
        assert.equal(h.applyPending(), null, 'nothing is pending for the new session');
        assert.equal(h.ui().provider, resumedRoute.provider, 'the display shows the new session route');
        assert.equal(h.ui().model, resumedRoute.model);
        assert.equal(h.ui().effort, resumedRoute.effort);
        assert.equal(h.ui().commandBusy, false, 'the lock is released');
      });
    }
  }
}

test('without a transition a selection adopts, refreshes and registers for its own session', async () => {
  const h = build('A');
  await h.api.setRoute(requestedModel);
  assert.equal(h.rt.route.model, requestedModel.model);
  assert.equal(h.rt.route.effectiveEffort, 'high', 'the real refresh completed against the adopted route');
  assert.equal(h.ui().model, requestedModel.model);
  assert.ok(h.applyPending());
  assert.equal(h.rt.session.model, requestedModel.model);
  assert.equal(h.ui().commandBusy, false);
});

test('the session generation advances for another session or none, not for the same session reinstalled', () => {
  const rt = trackSessionGeneration({ session: { id: 'A' } });
  assert.equal(rt.sessionGeneration, 0);
  rt.session = { id: 'A', refreshed: true };
  assert.equal(rt.sessionGeneration, 0);
  rt.session = null;
  assert.equal(rt.sessionGeneration, 1);
  rt.session = { id: 'B' };
  assert.equal(rt.sessionGeneration, 2);
  rt.session = { id: 'B' };
  assert.equal(rt.sessionGeneration, 2);
});
