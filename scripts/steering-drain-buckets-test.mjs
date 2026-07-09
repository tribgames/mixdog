import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFlow } from '../src/tui/engine/session-flow.mjs';

// Minimal bag: drainPendingSteering only touches pending, the queue helpers,
// and commitSteeringQueueEntries (which no-ops on disk when runtime.id is not
// a valid session key). No provider/runTurn wiring needed.
function makeFlow() {
  let seq = 0;
  const state = { queued: [], busy: false };
  const bag = {
    runtime: { id: null },
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    flags: {},
    pending: [],
    pendingNotificationKeys: new Set(),
    displayedExecutionNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    pushItem: () => {},
    replaceItems: () => {},
    pushNotice: () => {},
    pushUserOrSyntheticItem: () => {},
    autoClearState: () => ({ enabled: false }),
    agentStatusState: {},
    routeState: {},
    syncContextStats: () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
  };
  return { flow: createSessionFlow(bag), bag };
}

test('drainPendingSteering empties every non-slash priority/mode bucket in one call', () => {
  const { flow, bag } = makeFlow();
  // Concurrent user steering (prompt bucket) + task notification (its own
  // priority/mode bucket) queued while a turn is running.
  bag.pending.push(flow.makeQueueEntry('steer the turn', { mode: 'prompt' }));
  bag.pending.push(flow.makeQueueEntry('task finished', { mode: 'task-notification', key: 'task-1' }));

  const out = flow.drainPendingSteering();

  assert.equal(bag.pending.length, 0, 'no bucket left pending to spawn a follow-up turn');
  assert.equal(out.length, 2, 'both buckets injected into the current turn');
  assert.ok(out.some((v) => String(typeof v === 'string' ? v : v.text).includes('steer the turn')));
  assert.ok(out.some((v) => String(typeof v === 'string' ? v : v.text).includes('task finished')));
});

test('drainPendingSteering leaves slash commands pending for the post-turn processor', () => {
  const { flow, bag } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('/clear', { mode: 'prompt' }));
  bag.pending.push(flow.makeQueueEntry('steer text', { mode: 'prompt' }));

  const out = flow.drainPendingSteering();

  assert.equal(out.length, 1, 'only the non-slash entry drained');
  assert.equal(bag.pending.length, 1, 'slash command stays queued');
  assert.equal(bag.pending[0].content, '/clear');
});
