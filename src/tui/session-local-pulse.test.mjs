import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimePulse } from './session-local.mjs';
import { createContextState } from './session/context-state.mjs';
import { createSessionDraftStore } from './session/draft-store.mjs';

// The 2s runtime pulse republishes runtime-derived route / context / agent
// state only when it changed: an idle session must not mint a new published
// snapshot (which the session service projects as a new revision and which
// kept its idle-projection release from firing), while real changes —
// including context fields staged into the draft without a frame — publish.

function harness() {
  const runtime = {
    id: 'sess-1',
    session: {},
    model: 'model-a',
    provider: 'provider-a',
    effort: 'medium',
    effortOptions: ['low', 'medium', 'high'],
    fast: false,
    fastCapable: false,
    contextPercent: 10,
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    effectiveContextWindowPercent: 100,
    cwd: '/work',
    context: { lastApiRequestTokens: 1000, contextWindow: 180_000, compaction: { boundaryTokens: 150_000 } },
    agents: { agentWorkers: [], agentJobs: [] },
    contextStatus() {
      return this.context;
    },
    agentStatus() {
      return { ...this.agents, agentWorkers: [...this.agents.agentWorkers], agentJobs: [...this.agents.agentJobs] };
    },
  };
  const draft = { state: null };
  const flags = { disposed: false, pendingSessionReset: false };
  const context = createContextState({
    runtime,
    getState: () => draft.state,
    updateState: (patch) => {
      draft.state = { ...draft.state, ...patch };
    },
    getPendingSessionReset: () => false,
    getVisibleGoal: () => null,
  });
  draft.state = { items: [], structureRevision: 0, busy: false, stats: { turns: 0 }, ...context.baseRouteState() };
  let notified = 0;
  const listeners = new Set([() => notified++]);
  const store = createSessionDraftStore({ draft, listeners, isDisposed: () => false, onBusyReleased() {} });
  let mirroring = false;
  const pulse = createRuntimePulse({
    flags,
    liveShareMirroring: () => mirroring,
    getState: store.getState,
    getPublishedState: store.getPublishedState,
    set: store.set,
    emit: store.emit,
    routeState: context.routeState,
    agentStatusState: () => context.agentStatusState({ force: true }),
    syncContextStats: context.syncContextStats,
  });
  const tick = () => {
    pulse();
    store.flushEmit();
  };
  return {
    runtime,
    store,
    tick,
    notifications: () => notified,
    setMirroring: (value) => {
      mirroring = value;
    },
  };
}

test('the pulse does not re-publish an unchanged session', () => {
  const { store, tick, notifications } = harness();
  tick(); // first pulse publishes the context gauge fields it staged
  const settled = store.getPublishedState();
  const count = notifications();
  for (let i = 0; i < 5; i += 1) tick();
  assert.equal(store.getPublishedState(), settled, 'no new snapshot for an idle session');
  assert.equal(notifications(), count, 'no listener fired');
});

test('the pulse publishes route, context stats and agent status changes', () => {
  const { runtime, store, tick, notifications } = harness();
  tick();
  let count = notifications();

  runtime.model = 'model-b';
  tick();
  assert.equal(store.getPublishedState().model, 'model-b');
  assert.equal(notifications(), ++count);

  runtime.context = { ...runtime.context, lastApiRequestTokens: 4200 };
  tick();
  assert.equal(store.getPublishedState().stats.currentContextTokens, 4200);
  assert.equal(notifications(), ++count);

  runtime.agents = { agentWorkers: [{ id: 'w1', status: 'running' }], agentJobs: [] };
  tick();
  assert.deepEqual(store.getPublishedState().agentWorkers, [{ id: 'w1', status: 'running' }]);
  assert.equal(notifications(), ++count);

  // Only a draft-staged display field changes (syncContextStats writes it
  // straight into the draft, so set() alone sees nothing new): still published.
  runtime.context = { ...runtime.context, contextWindow: 190_000 };
  tick();
  assert.equal(store.getPublishedState().displayContextWindow, 190_000);
  assert.equal(notifications(), ++count);

  const settled = store.getPublishedState();
  tick();
  tick();
  assert.equal(store.getPublishedState(), settled, 'quiet again once the change is published');
  assert.equal(notifications(), count);
});

test('a live-share viewer pulse publishes only a changed route', () => {
  const { runtime, store, tick, notifications, setMirroring } = harness();
  tick();
  setMirroring(true);
  const settled = store.getPublishedState();
  const count = notifications();
  runtime.context = { ...runtime.context, lastApiRequestTokens: 9999 };
  tick();
  assert.equal(store.getPublishedState(), settled, 'owner frames own stats; nothing local republished');
  assert.equal(notifications(), count);
  runtime.effort = 'high';
  tick();
  assert.equal(store.getPublishedState().effort, 'high');
  assert.equal(store.getPublishedState().stats.currentContextTokens, 1000);
});
