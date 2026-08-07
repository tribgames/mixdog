import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFlow } from '../src/tui/session/session-flow.mjs';
import { createSessionApiA } from '../src/tui/session/session-api.mjs';

// Regression harness for prompt loss when a submit races an in-flight session
// command (commandBusy) or an auto-clear. Wires the real session-flow queue
// (enqueue/drain) + the real submit() against a minimal bag whose set() mirrors
// session.mjs's commandBusy-release drain kick.
function makeEngine({
  autoClearBeforeSubmit,
  autoClearEnabled = false,
  autoClearConfig = null,
  sessionLastUsedAt = Date.now() - 1000,
  contextStatus = null,
  compactionSettings = {},
  runtimeClear = async () => true,
} = {}) {
  let seq = 0;
  const executed = [];
  const providerRequests = [];
  let resolveProviderDispatch;
  const providerDispatch = new Promise((resolve) => { resolveProviderDispatch = resolve; });
  let state = {
    items: [{ kind: 'user', id: 'existing', text: 'existing prompt' }],
    queued: [],
    busy: false,
    commandBusy: false,
  };
  const bag = {
    runtime: {
      // Queue mechanics are under test here, not durable recovery. An invalid
      // lead id keeps the harness from mirroring fixture prompts into the real
      // ~/.mixdog/data spool when a case temporarily sets busy=true.
      id: null,
      session: {
        id: 'session_1',
        messages: [{ role: 'user', content: 'existing prompt' }],
        lastUsedAt: sessionLastUsedAt,
      },
      getCompactionSettings: () => compactionSettings,
      contextStatus: () => contextStatus,
      clear: runtimeClear,
      consumePendingSessionReset: () => null,
      ask: async (text) => {
        providerRequests.push(text);
        resolveProviderDispatch(text);
        return { result: { content: 'ok' }, session: bag.runtime.session };
      },
    },
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    flags: {},
    pending: [],
    listeners: new Set(),
    pendingNotificationKeys: new Set(),
    displayedExecutionNotificationKeys: new Set(),
    clearToastTimers: () => {},
    getState: () => state,
    set: (patch) => {
      if (!patch || typeof patch !== 'object') return false;
      const commandBusyReleased = state.commandBusy === true
        && Object.prototype.hasOwnProperty.call(patch, 'commandBusy')
        && patch.commandBusy === false;
      const busyReleased = state.busy === true
        && Object.prototype.hasOwnProperty.call(patch, 'busy')
        && patch.busy === false;
      state = { ...state, ...patch };
      if (commandBusyReleased || busyReleased) queueMicrotask(() => { void bag.drain?.(); });
      return true;
    },
    pushItem: (item) => { state = { ...state, items: [...state.items, item] }; },
    patchItem: () => {},
    replaceItems: (x) => x,
    pushNotice: () => {},
    pushUserOrSyntheticItem: (text, id) => {
      executed.push(text);
      state = { ...state, items: [...state.items, { kind: 'user', id, text }] };
    },
    autoClearState: () => autoClearConfig || ({ enabled: autoClearEnabled, idleMs: 0, minContextPercent: 0 }),
    agentStatusState: () => ({}),
    routeState: () => ({}),
    syncContextStats: () => {},
    denyAllToolApprovals: () => {},
    updateAgentJobCard: () => {},
    requeueEntriesFront: () => {},
    resetStatsAndSyncContext: () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
    runTurn: async (text) => {
      await bag.runtime.ask(text);
      return 'ok';
    },
  };
  Object.assign(bag, createSessionFlow(bag));
  if (autoClearBeforeSubmit) bag.autoClearBeforeSubmit = autoClearBeforeSubmit;
  const api = createSessionApiA(bag);
  return {
    api,
    bag,
    getExecuted: () => executed,
    getProviderRequests: () => providerRequests,
    waitForProviderDispatch: (timeoutMs = 250) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`provider dispatch timed out after ${timeoutMs}ms`)), timeoutMs);
      providerDispatch.then((text) => {
        clearTimeout(timer);
        resolve(text);
      }, reject);
    }),
    getState: () => bag.getState(),
    mutateState: (mutator) => { mutator(state); },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('submit during commandBusy queues the prompt instead of dropping it', async () => {
  const { api, bag, getExecuted } = makeEngine();
  bag.set({ commandBusy: true });
  const ok = api.submit('queued while busy');
  assert.equal(ok, true, 'submit accepted (not dropped)');
  assert.equal(bag.pending.length, 1, 'prompt preserved in queue');
  await tick();
  assert.equal(getExecuted().length, 0, 'drain bails while commandBusy');
  bag.set({ commandBusy: false });
  await tick(); await tick();
  assert.deepEqual(getExecuted(), ['queued while busy'], 'prompt runs after command releases');
  assert.equal(bag.pending.length, 0);
});

test('blocked drain retries even if commandBusy is cleared outside set hook', async () => {
  const { api, bag, getExecuted, mutateState } = makeEngine();
  bag.set({ commandBusy: true });
  assert.equal(api.submit('queued until direct release'), true);
  assert.equal(bag.pending.length, 1);
  await tick();
  assert.equal(getExecuted().length, 0);

  mutateState((state) => { state.commandBusy = false; });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(getExecuted(), ['queued until direct release']);
  assert.equal(bag.pending.length, 0);
});

test('busy release centrally re-kicks a prompt deferred behind an active turn', async () => {
  const { api, bag, getExecuted } = makeEngine();
  bag.set({ busy: true });
  assert.equal(api.submit('queued behind active turn'), true);
  assert.equal(bag.pending.length, 1);
  await tick();
  assert.equal(getExecuted().length, 0);
  bag.set({ busy: false });
  await tick(); await tick();
  assert.deepEqual(getExecuted(), ['queued behind active turn']);
  assert.equal(bag.pending.length, 0);
});

test('idle submit runs the prompt after autoClearBeforeSubmit resolves', async () => {
  const { api, getExecuted, bag } = makeEngine();
  const ok = api.submit('idle prompt');
  assert.equal(ok, true);
  await tick(); await tick();
  assert.deepEqual(getExecuted(), ['idle prompt']);
  assert.equal(bag.pending.length, 0);
});

test('submit still enqueues when autoClearBeforeSubmit rejects', async () => {
  const { api, getExecuted } = makeEngine({
    autoClearBeforeSubmit: () => Promise.reject(new Error('compaction timed out')),
  });
  const ok = api.submit('survives rejection');
  assert.equal(ok, true);
  await tick(); await tick();
  assert.deepEqual(getExecuted(), ['survives rejection'], 'rejected auto-clear must not lose the prompt');
});

test('runtime clear false skips auto-clear and sends the first post-failure prompt to the provider', async () => {
  const {
    api, bag, getExecuted, getProviderRequests, getState,
  } = makeEngine({ autoClearEnabled: true, runtimeClear: async () => false });

  assert.equal(api.submit('first after failed auto-clear'), true);
  await tick(); await tick();

  assert.deepEqual(getExecuted(), ['first after failed auto-clear'], 'user card remains visible');
  assert.deepEqual(getProviderRequests(), ['first after failed auto-clear'], 'first post-failure input reaches provider');
  assert.equal(getState().items.some((item) => item.label === 'Auto-clear skipped'), true);
  assert.equal(getState().items.some((item) => item.label === 'Auto-clear complete'), false);
  assert.equal(getState().items.some((item) => item.id === 'existing'), true, 'failed clear preserves the existing session UI');
  assert.equal(bag.runtime.session.messages[0].content, 'existing prompt', 'failed clear preserves the runtime session');
});

test('idle submit compacts when a zero usedTokens field has a live estimate above the context gate', async () => {
  const clearCalls = [];
  const { api, getState } = makeEngine({
    autoClearConfig: { enabled: true, idleMs: 60_000, minContextPercent: 10 },
    sessionLastUsedAt: Date.now() - 120_000,
    contextStatus: {
      usedTokens: 0,
      currentEstimatedTokens: 20,
      compaction: { triggerTokens: 100 },
    },
    compactionSettings: { compactType: 'summary' },
    runtimeClear: async (options) => {
      clearCalls.push(options);
      return true;
    },
  });

  assert.equal(api.submit('after real idle'), true);
  await tick(); await tick(); await tick();
  assert.deepEqual(clearCalls, [{ compactType: 'summary', requireCompactSuccess: true }]);
  assert.equal(getState().items.some((item) => item.label === 'Auto-clear complete'), true);
});

test('idle submit skips auto-clear when context gate operands are non-finite', async () => {
  for (const contextStatus of [
    { usedTokens: Infinity, compaction: { triggerTokens: 100 } },
    { usedTokens: 20, compaction: { triggerTokens: Infinity } },
  ]) {
    const clearCalls = [];
    const { api } = makeEngine({
      autoClearConfig: { enabled: true, idleMs: 60_000, minContextPercent: 10 },
      sessionLastUsedAt: Date.now() - 120_000,
      contextStatus,
      compactionSettings: { compactType: 'summary' },
      runtimeClear: async (options) => {
        clearCalls.push(options);
        return true;
      },
    });
    assert.equal(api.submit('after real idle'), true);
    await tick(); await tick();
    assert.deepEqual(clearCalls, []);
  }
});

test('late runtime clear false keeps the UI skipped and sends the first post-timeout prompt', async () => {
  let resolveClear;
  let harness;
  const autoClearBeforeSubmit = () => harness.bag.performSessionClear({
    verb: 'Auto-clearing idle conversation',
    doneLabel: 'Auto-clear complete',
    skipLabel: 'Auto-clear skipped',
    surface: 'auto-clear',
    useCompaction: true,
    compactTimeoutMs: 5,
  });
  harness = makeEngine({
    autoClearBeforeSubmit,
    runtimeClear: () => new Promise((resolve) => { resolveClear = resolve; }),
  });
  harness.bag.runtime.getCompactionSettings = () => ({ compactType: 'summary' });

  assert.equal(harness.api.submit('first after timed-out auto-clear'), true);
  await harness.waitForProviderDispatch();
  assert.equal(typeof resolveClear, 'function', 'compacting clear started');
  assert.deepEqual(
    harness.getProviderRequests(),
    ['first after timed-out auto-clear'],
    'first post-timeout input reaches provider before late clear settles',
  );

  resolveClear(false);
  await tick(); await tick();

  assert.equal(harness.getState().items.some((item) => item.label === 'Auto-clear skipped'), true);
  assert.equal(harness.getState().items.some((item) => item.label === 'Auto-clear complete'), false);
  assert.equal(harness.getState().items.some((item) => item.id === 'existing'), true, 'late false preserves the existing session UI');
  assert.equal(harness.bag.runtime.session.messages[0].content, 'existing prompt', 'late false preserves the runtime session');
});

test('empty and whitespace submits are still rejected', () => {
  const { api, bag } = makeEngine();
  assert.equal(api.submit('   '), false);
  assert.equal(bag.pending.length, 0);
});
