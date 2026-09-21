import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionResetOps } from './session-reset.mjs';

// What a failed session reset must put back on screen: the snapshot's rows and
// live activity, the freshly synced context stats, and the current route/agent
// state published with them.
function harness() {
  let state = {
    items: [{ id: 'u1', kind: 'user', text: 'hello' }],
    transcriptViewItems: [{ id: 'u1' }],
    transcriptViewRevision: 7,
    toasts: [{ id: 't1' }],
    queued: [{ id: 'q1' }],
    thinking: 'pondering',
    spinner: 'dots',
    lastTurn: { id: 'turn-1' },
    busy: true,
    stats: { turns: 3 },
    sessionId: 'sess-1',
  };
  const calls = { syncContextStats: [], restoredSpill: [], releasedSpill: [] };
  const flags = { pendingSessionReset: true };
  const set = (patch) => {
    state = { ...state, ...patch };
  };
  const ops = createSessionResetOps({
    flags,
    pendingNotificationKeys: new Set(),
    displayedExecutionNotificationKeys: new Set(),
    clearExecutionDedupState: () => {},
    clearToastTimers: () => {},
    getState: () => state,
    set,
    replaceItems: (items) => items.slice(),
    agentStatusState: () => ({ agentWorkers: ['w1'] }),
    routeState: () => ({ provider: 'p1', model: 'm1' }),
    syncContextStats: (options) => {
      calls.syncContextStats.push(options);
      set({ stats: { ...state.stats, contextTokens: 42 } });
    },
    snapshotTranscriptSpill: () => ({ spill: 'snap' }),
    restoreTranscriptSpill: (spill) => calls.restoredSpill.push(spill),
    releaseTranscriptSpill: (spill) => calls.releasedSpill.push(spill),
  });
  return { ops, flags, calls, state: () => state, set };
}

test('a failed reset restores the snapshot plus the synced stats and current route/agent state', () => {
  const { ops, flags, calls, state, set } = harness();
  const before = state();
  const snapshot = ops.snapshotTuiBeforeSessionReset();

  ops.resetTuiForPendingSessionReset();
  assert.equal(flags.pendingSessionReset, true);
  assert.deepEqual(state().items, []);
  assert.equal(state().busy, false);
  set({ sessionId: null });

  ops.restoreTuiAfterFailedSessionReset(snapshot);

  const after = state();
  assert.equal(flags.pendingSessionReset, false);
  assert.deepEqual(calls.restoredSpill, [{ spill: 'snap' }]);
  assert.deepEqual(calls.syncContextStats, [{ allowEstimated: true }]);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.transcriptViewItems, before.transcriptViewItems);
  assert.equal(after.transcriptViewRevision, 7);
  assert.deepEqual(after.toasts, before.toasts);
  assert.deepEqual(after.queued, before.queued);
  assert.equal(after.thinking, 'pondering');
  assert.equal(after.spinner, 'dots');
  assert.deepEqual(after.lastTurn, { id: 'turn-1' });
  assert.equal(after.busy, true);
  assert.deepEqual(after.stats, { turns: 3, contextTokens: 42 }, 'the synced context stats survive the republish');
  assert.equal(after.provider, 'p1');
  assert.equal(after.model, 'm1');
  assert.deepEqual(after.agentWorkers, ['w1']);
  assert.equal(after.sessionId, null, 'the restore never republishes the session id');
});

test('restoring without a snapshot does nothing at all', () => {
  const { ops, calls, state } = harness();
  const before = state();
  ops.restoreTuiAfterFailedSessionReset(null);
  assert.equal(state(), before);
  assert.deepEqual(calls.syncContextStats, []);
  assert.deepEqual(calls.restoredSpill, []);
});

test('committing a reset releases the snapshot spill', () => {
  const { ops, calls } = harness();
  ops.commitTuiSessionReset({ transcriptSpill: { spill: 'snap' } });
  ops.commitTuiSessionReset(null);
  assert.deepEqual(calls.releasedSpill, [{ spill: 'snap' }, undefined]);
});
