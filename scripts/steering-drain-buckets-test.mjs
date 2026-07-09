import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFlow } from '../src/tui/engine/session-flow.mjs';

// Minimal bag: drainPendingSteering only touches pending, the queue helpers,
// and commitSteeringQueueEntries (which no-ops on disk when runtime.id is not
// a valid session key). No provider/runTurn wiring needed.
function makeFlow() {
  let seq = 0;
  let runTurns = 0;
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
    runTurn: async () => {
      runTurns += 1;
      return 'done';
    },
  };
  return { flow: createSessionFlow(bag), bag, getRunTurns: () => runTurns };
}

test('drainPendingSteering drains prompt/next mid-turn but leaves later notifications', () => {
  const { flow, bag } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('steer the turn', { mode: 'prompt' }));
  bag.pending.push(flow.makeQueueEntry('task finished', { mode: 'task-notification', key: 'task-1' }));

  const out = flow.drainPendingSteering();

  assert.equal(out.length, 1, 'next-priority prompt is injected into the active continuation');
  assert.equal(out[0], 'steer the turn');
  assert.equal(bag.pending.length, 1, 'later task notification waits for post-turn or explicit later flush');
  assert.equal(bag.pending[0].content, 'task finished');
});

test('drainPendingSteering can explicitly flush later notifications', () => {
  const { flow, bag } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('task finished', { mode: 'task-notification', key: 'task-1' }));

  const out = flow.drainPendingSteering({ maxPriority: 'later' });

  assert.equal(out.length, 1);
  assert.equal(out[0], 'task finished');
  assert.equal(bag.pending.length, 0);
});

test('drainPendingSteering accepts runtime callback signature', () => {
  const { flow, bag } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('task finished', { mode: 'task-notification', key: 'task-1' }));

  const out = flow.drainPendingSteering('session-id', { maxPriority: 'later' });

  assert.deepEqual(out, ['task finished']);
  assert.equal(bag.pending.length, 0);
});

test('drained notification key remains deduped and displayed key is not cleared', () => {
  const { flow, bag } = makeFlow();
  bag.getState().busy = true;
  assert.equal(flow.enqueue('task finished', { mode: 'task-notification', key: 'task-1' }), true);
  bag.displayedExecutionNotificationKeys.add('task-1');

  const out = flow.drainPendingSteering({ maxPriority: 'later' });

  assert.deepEqual(out, ['task finished']);
  assert.equal(flow.enqueue('task duplicate', { mode: 'task-notification', key: 'task-1' }), false);
  assert.equal(bag.displayedExecutionNotificationKeys.has('task-1'), true);
});

test('drainPendingSteering leaves slash commands pending', () => {
  const { flow, bag } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('/clear', { mode: 'prompt' }));
  bag.pending.push(flow.makeQueueEntry('steer text', { mode: 'prompt' }));

  const out = flow.drainPendingSteering();

  assert.equal(out.length, 1, 'non-slash prompt drains');
  assert.equal(out[0], 'steer text');
  assert.equal(bag.pending.length, 1, 'slash command stays queued for post-turn processing');
  assert.equal(bag.pending[0].content, '/clear');
});

test('enqueue while busy does not start a parallel Lead turn', async () => {
  const { flow, bag, getRunTurns } = makeFlow();
  bag.getState().busy = true;

  assert.equal(flow.enqueue('scheduled message', { mode: 'task-notification' }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getRunTurns(), 0, 'busy enqueue must wait for active turn boundary');
  assert.equal(bag.pending.length, 1, 'message remains pending for post-turn drain');
});

test('post-turn drain does not send queued slash command to model', async () => {
  const { flow, bag, getRunTurns } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('/clear', { mode: 'prompt' }));

  await flow.drain();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getRunTurns(), 0, 'slash command must not be runTurn model text');
  assert.equal(bag.pending.length, 1, 'slash command remains for command dispatcher');
  assert.equal(bag.pending[0].content, '/clear');
});
