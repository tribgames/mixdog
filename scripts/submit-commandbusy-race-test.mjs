import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFlow } from '../src/tui/engine/session-flow.mjs';
import { createEngineApiA } from '../src/tui/engine/session-api.mjs';

// Regression harness for prompt loss when a submit races an in-flight session
// command (commandBusy) or an auto-clear. Wires the real session-flow queue
// (enqueue/drain) + the real submit() against a minimal bag whose set() mirrors
// engine.mjs's commandBusy-release drain kick.
function makeEngine({ autoClearBeforeSubmit } = {}) {
  let seq = 0;
  const executed = [];
  let state = { queued: [], busy: false, commandBusy: false };
  const bag = {
    runtime: { id: null, consumePendingSessionReset: () => null },
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    flags: {},
    pending: [],
    listeners: new Set(),
    pendingNotificationKeys: new Set(),
    displayedExecutionNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => {
      if (!patch || typeof patch !== 'object') return false;
      const released = state.commandBusy === true
        && Object.prototype.hasOwnProperty.call(patch, 'commandBusy')
        && patch.commandBusy === false;
      state = { ...state, ...patch };
      if (released) queueMicrotask(() => { void bag.drain?.(); });
      return true;
    },
    pushItem: () => {},
    patchItem: () => {},
    replaceItems: (x) => x,
    pushNotice: () => {},
    pushUserOrSyntheticItem: (text) => { executed.push(text); },
    autoClearState: () => ({ enabled: false }),
    agentStatusState: () => ({}),
    routeState: () => ({}),
    syncContextStats: () => {},
    denyAllToolApprovals: () => {},
    updateAgentJobCard: () => {},
    requeueEntriesFront: () => {},
    resetStatsAndSyncContext: () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
    runTurn: async () => 'ok',
  };
  Object.assign(bag, createSessionFlow(bag));
  if (autoClearBeforeSubmit) bag.autoClearBeforeSubmit = autoClearBeforeSubmit;
  const api = createEngineApiA(bag);
  return {
    api,
    bag,
    getExecuted: () => executed,
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

test('empty and whitespace submits are still rejected', () => {
  const { api, bag } = makeEngine();
  assert.equal(api.submit('   '), false);
  assert.equal(bag.pending.length, 0);
});
