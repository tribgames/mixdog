// Regression: a SETTLED abort (runtime.abort unwinds the turn and busy clears)
// with queued prompts must still end with a drain kick, even when no drain
// loop owns the aborted turn. Abort preserves pending input for the next
// turn, and the command queue survives cancel and fires when idle. Before the
// fix only the STARVED path (recovery timer) re-kicked drain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFlow } from '../src/tui/session/session-flow.mjs';
import { createSessionApiA } from '../src/tui/session/session-api.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEngine() {
  let seq = 0;
  let drainCount = 0;
  let state = { items: [], queued: [], busy: false, commandBusy: false, spinner: null, thinking: null, lastTurn: null };
  const bag = {
    runtime: {
      id: null,
      consumePendingSessionReset: () => null,
      // Settled abort: busy clears like the real turn finally.
      abort: () => { bag.set({ busy: false, spinner: null, thinking: null, lastTurn: null }); return true; },
    },
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    flags: { leadTurnEpoch: 1, disposed: false, draining: false, activePromptRestore: null },
    pending: [],
    listeners: new Set(),
    getState: () => state,
    set: (patch) => { state = { ...state, ...patch }; return true; },
    pushItem: () => {},
    patchItem: () => {},
    replaceItems: (x) => x,
    pushNotice: () => {},
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
    discardExecutionPendingResume: () => {},
    drain: async () => { drainCount += 1; },
    runTurn: async () => 'ok',
  };
  Object.assign(bag, createSessionFlow(bag));
  bag.drain = async () => { drainCount += 1; };
  const api = createSessionApiA(bag);
  return { api, bag, getDrainCount: () => drainCount };
}

test('settled abort with queued prompt kicks drain so the queue promotes', async () => {
  const { api, bag, getDrainCount } = makeEngine();
  bag.set({ busy: true, spinner: { active: true } });
  bag.pending.push({ kind: 'prompt', mode: 'prompt', text: 'queued next', id: 'q1' });
  api.abort();
  assert.equal(bag.getState().busy, false, 'settled abort cleared busy');
  await wait(400);
  assert.ok(getDrainCount() >= 1, 'post-abort kick drained the queued prompt');
});

test('settled abort with empty queue does not spin drain', async () => {
  const { api, bag, getDrainCount } = makeEngine();
  bag.set({ busy: true });
  api.abort();
  await wait(400);
  assert.equal(getDrainCount(), 0, 'no queued work → no drain kick');
});
