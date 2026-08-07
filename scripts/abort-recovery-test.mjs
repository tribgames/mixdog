#!/usr/bin/env node
// Regression: Esc dispatches canonical cancellation reasons and preserves the
// prompt/completion ownership rules while runtime.ask() performs the unwind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFlow } from '../src/tui/session/session-flow.mjs';
import { createSessionApiA } from '../src/tui/session/session-api.mjs';

// Minimal engine bag exercising only the abort surface.
function makeEngine({ abortSettles = false } = {}) {
  let seq = 0;
  const notices = [];
  const requeued = [];
  const discardedCompletionKeys = [];
  const abortReasons = [];
  let drainCount = 0;
  let state = { items: [], queued: [], busy: false, commandBusy: false, spinner: null, thinking: null, lastTurn: null };
  const bag = {
    runtime: {
      id: null,
      consumePendingSessionReset: () => null,
      abort: (reason) => {
        abortReasons.push(reason);
        if (abortSettles) bag.set({ busy: false, spinner: null, thinking: null, lastTurn: null });
        return true;
      },
    },
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    flags: { leadTurnEpoch: 1, disposed: false, draining: false, activePromptRestore: null },
    pending: [],
    listeners: new Set(),
    getState: () => state,
    set: (patch) => {
      if (!patch || typeof patch !== 'object') return false;
      state = { ...state, ...patch };
      return true;
    },
    pushItem: () => {},
    patchItem: () => {},
    replaceItems: (x) => x,
    pushNotice: (text, level) => { notices.push({ text, level }); },
    pushUserOrSyntheticItem: () => {},
    autoClearState: () => ({ enabled: false }),
    agentStatusState: () => ({}),
    routeState: () => ({}),
    syncContextStats: () => {},
    denyAllToolApprovals: () => {},
    updateAgentJobCard: () => {},
    requeueEntriesFront: (entries) => { requeued.push(...entries); },
    resetStatsAndSyncContext: () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
    discardExecutionPendingResume: (keys) => { discardedCompletionKeys.push(...keys); },
    drain: async () => { drainCount += 1; },
    runTurn: async () => 'ok',
  };
  Object.assign(bag, createSessionFlow(bag));
  bag.drain = async () => { drainCount += 1; };
  const api = createSessionApiA(bag);
  return {
    api,
    bag,
    getNotices: () => notices,
    getDrainCount: () => drainCount,
    getRequeued: () => requeued,
    getDiscardedCompletionKeys: () => discardedCompletionKeys,
    getAbortReasons: () => abortReasons,
  };
}

test('Esc uses Claude-compatible user-cancel and queued interrupt reasons', () => {
  const normal = makeEngine({ abortSettles: true });
  normal.bag.set({ busy: true });
  normal.api.abort();
  assert.deepEqual(normal.getAbortReasons(), ['user-cancel']);

  const queued = makeEngine({ abortSettles: true });
  queued.bag.set({ busy: true });
  queued.bag.pending.push({ kind: 'prompt', text: 'queued redirect' });
  queued.api.abort();
  assert.deepEqual(queued.getAbortReasons(), ['interrupt']);
});

test('Esc with a replacement draft cancels without rewinding the submitted prompt', () => {
  const { api, bag } = makeEngine({ abortSettles: true });
  bag.flags.activePromptRestore = {
    text: 'submitted prompt',
    restorable: true,
    submittedIds: ['user_1'],
    requeueEntries: [],
    discardExecutionPendingResumeKeys: [],
  };
  bag.set({
    busy: true,
    items: [{ id: 'user_1', kind: 'user', text: 'submitted prompt' }],
    promptHistoryList: ['submitted prompt'],
  });

  const result = api.abort({ restorePrompt: false });
  assert.equal(result.aborted, true);
  assert.equal(result.restoreText, '');
  assert.equal(bag.getState().items.length, 1, 'the submitted transcript row is not rewound');
  assert.deepEqual(bag.getState().promptHistoryList, ['submitted prompt']);
});

test('a settled runtime abort needs no UI recovery state', () => {
  const { api, bag, getNotices } = makeEngine({ abortSettles: true });
  bag.set({ busy: true, spinner: { active: true } });
  const res = api.abort();
  assert.equal(res.aborted, true);
  assert.equal(bag.getState().busy, false, 'settled abort cleared busy synchronously');
  assert.equal(getNotices().some((n) => /did not settle/i.test(n.text)), false, 'no spurious recovery notice');
});

for (const phase of ['before first delta', 'after response progress']) {
  test(`Esc ${phase} abandons the active completion resume`, () => {
    const {
      api, bag, getRequeued, getDiscardedCompletionKeys,
    } = makeEngine({ abortSettles: true });
    bag.flags.activePromptRestore = {
      text: 'completion response',
      restorable: false,
      committed: false,
      requeueEntries: [{
        mode: 'pending-resume',
        text: 'completion response',
        abortDiscardOnAbort: true,
      }],
      discardExecutionPendingResumeKeys: ['execution_A'],
    };
    bag.set({
      busy: true,
      spinner: { active: true, responseLength: phase === 'after response progress' ? 24 : 0 },
      thinking: phase === 'after response progress' ? { text: 'working' } : null,
    });

    assert.equal(api.abort().aborted, true);
    assert.equal(bag.getState().busy, false, 'Esc releases the active completion turn');
    assert.equal(bag.getState().spinner, null, 'spinner is cleared');
    assert.equal(bag.getState().thinking, null, 'thinking is cleared');
    assert.deepEqual(getRequeued(), [], 'the completion resume is not requeued');
    assert.deepEqual(getDiscardedCompletionKeys(), ['execution_A'], 'its completion ownership is retired');
  });
}
