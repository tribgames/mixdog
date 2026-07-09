#!/usr/bin/env node
// Regression: bounded manual-abort recovery. Esc calls runtime.abort(), which
// normally rejects the in-flight runtime.ask() so the turn's finally clears
// busy. If that unwind is STARVED (provider abort never settles after a
// post-tool fetch stall), busy must not stay true forever — a short grace timer
// hard-releases the store and re-kicks drain. A normal abort that settles in
// time must NOT be masked by the recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFlow } from '../src/tui/engine/session-flow.mjs';
import { createEngineApiA } from '../src/tui/engine/session-api.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal engine bag exercising only the abort() recovery path. `abortSettles`
// models whether runtime.abort() actually unwinds the turn (clears busy) — the
// starved case leaves busy=true so the recovery timer must fire.
function makeEngine({ abortSettles = false, recoveryMs = 30 } = {}) {
  let seq = 0;
  const notices = [];
  let drainCount = 0;
  let state = { items: [], queued: [], busy: false, commandBusy: false, spinner: null, thinking: null, lastTurn: null };
  const bag = {
    runtime: {
      id: null,
      consumePendingSessionReset: () => null,
      abort: () => {
        if (abortSettles) bag.set({ busy: false, spinner: null, thinking: null, lastTurn: null });
        return true;
      },
    },
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    flags: { leadTurnEpoch: 1, disposed: false, draining: false, activePromptRestore: null, manualAbortRecoveryMs: recoveryMs },
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
    requeueEntriesFront: () => {},
    resetStatsAndSyncContext: () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
    drain: async () => { drainCount += 1; },
    runTurn: async () => 'ok',
  };
  Object.assign(bag, createSessionFlow(bag));
  bag.drain = async () => { drainCount += 1; };
  const api = createEngineApiA(bag);
  return { api, bag, getNotices: () => notices, getDrainCount: () => drainCount };
}

test('starved abort → bounded recovery hard-releases busy and re-kicks drain', async () => {
  const { api, bag, getNotices, getDrainCount } = makeEngine({ abortSettles: false, recoveryMs: 25 });
  bag.set({ busy: true, spinner: { active: true } });
  bag.pending.push({ kind: 'prompt', text: 'queued next' });
  const res = api.abort();
  assert.equal(res.aborted, true, 'abort dispatched to runtime');
  assert.equal(bag.getState().busy, true, 'still busy immediately after abort (unwind pending)');
  await wait(60);
  assert.equal(bag.getState().busy, false, 'recovery timer force-releases busy');
  assert.equal(bag.getState().spinner, null, 'spinner cleared on recovery');
  assert.equal(bag.flags.leadTurnEpoch, 2, 'epoch bumped so stuck turn finally becomes a no-op');
  assert.equal(getDrainCount() >= 1, true, 'drain re-kicked so queued prompt runs');
  assert.equal(getNotices().some((n) => /did not settle/i.test(n.text)), true, 'user told input was restored');
});

test('starved abort abandons old drain owner before re-kicking drain', async () => {
  const { api, bag, getDrainCount } = makeEngine({ abortSettles: false, recoveryMs: 25 });
  bag.flags.draining = true;
  bag.flags.drainEpoch = 10;
  bag.set({ busy: true, spinner: { active: true } });
  bag.pending.push({ kind: 'prompt', text: 'queued next' });

  api.abort();
  await wait(60);

  assert.equal(bag.getState().busy, false);
  assert.equal(bag.flags.draining, false, 'stuck drain lock was released only after epoch abandonment');
  assert.equal(bag.flags.drainEpoch > 10, true, 'old drain owner invalidated');
  assert.equal(getDrainCount() >= 1, true, 'new drain kick requested for pending work');
});

test('abort that settles in time is NOT masked by recovery', async () => {
  const { api, bag, getNotices } = makeEngine({ abortSettles: true, recoveryMs: 25 });
  bag.set({ busy: true, spinner: { active: true } });
  const res = api.abort();
  assert.equal(res.aborted, true);
  assert.equal(bag.getState().busy, false, 'settled abort cleared busy synchronously');
  const epochAfter = bag.flags.leadTurnEpoch;
  await wait(60);
  assert.equal(bag.flags.leadTurnEpoch, epochAfter, 'recovery no-ops (no epoch bump) when busy already cleared');
  assert.equal(getNotices().some((n) => /did not settle/i.test(n.text)), false, 'no spurious recovery notice');
});

test('recovery no-ops if a newer turn already owns the store', async () => {
  const { api, bag } = makeEngine({ abortSettles: false, recoveryMs: 25 });
  bag.set({ busy: true });
  api.abort();
  bag.flags.leadTurnEpoch = 5;
  bag.set({ busy: true, spinner: { active: true, verb: 'new turn' } });
  await wait(60);
  assert.equal(bag.flags.leadTurnEpoch, 5, 'recovery must not touch a newer turn epoch');
  assert.equal(bag.getState().busy, true, 'newer turn stays busy — not force-released');
});
