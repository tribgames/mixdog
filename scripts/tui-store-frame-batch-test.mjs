import test from 'node:test';
import assert from 'node:assert/strict';

import { createFrameBatchedStorePublisher } from '../src/tui/engine/frame-batched-store.mjs';

function harness() {
  let draft = { items: [], structureRevision: 4 };
  let published = draft;
  const listeners = new Set();
  const timers = [];
  let unrefs = 0;
  let cancellations = 0;
  const publisher = createFrameBatchedStorePublisher({
    getState: () => draft,
    publishState: (next) => {
      published = Object.freeze(next);
      draft = { ...next, stats: next.stats ? { ...next.stats } : next.stats };
    },
    listeners,
    setTimer: (fn) => {
      const timer = { fn, cancelled: false, unref: () => { unrefs += 1; } };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cancelled = true;
      cancellations += 1;
    },
  });
  return {
    publisher,
    listeners,
    timers,
    getState: () => published,
    getDraft: () => draft,
    mutate: (fn) => { draft = fn(draft); },
    getUnrefs: () => unrefs,
    getCancellations: () => cancellations,
  };
}

test('frame publisher preserves mutation order and commits one revision/notification', () => {
  const h = harness();
  const snapshots = [];
  h.listeners.add(() => snapshots.push(h.getState()));
  h.mutate((state) => ({ ...state, items: [...state.items, 'agent-a'] }));
  h.publisher.markStructureChange();
  h.publisher.emit();
  h.mutate((state) => ({ ...state, items: [...state.items, 'tool-b'] }));
  h.publisher.markStructureChange();
  h.publisher.emit();

  assert.deepEqual(h.getDraft().items, ['agent-a', 'tool-b']);
  assert.equal(h.getDraft().structureRevision, 4);
  assert.deepEqual(h.getState().items, [], 'public snapshot stays on the prior atomic pair before flush');
  assert.equal(h.getState().structureRevision, 4);
  assert.equal(h.timers.length, 1);
  assert.equal(h.getUnrefs(), 1);
  h.timers[0].fn();
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].items, ['agent-a', 'tool-b']);
  assert.equal(snapshots[0].structureRevision, 5);

  // A getState()-style write targets the detached draft, never the object
  // already handed to useSyncExternalStore.
  h.getDraft().items = ['draft-only'];
  assert.deepEqual(h.getState().items, ['agent-a', 'tool-b']);
  assert.equal(h.getState().structureRevision, 5);
});

test('immediate flush publishes the same terminal batch', async () => {
  const h = harness();
  let notifications = 0;
  h.listeners.add(() => { notifications += 1; });
  h.mutate((state) => ({ ...state, items: ['echo'] }));
  h.publisher.markStructureChange();
  h.publisher.emit();
  h.publisher.flushImmediate();
  await Promise.resolve();
  assert.equal(notifications, 1);
  assert.equal(h.getState().structureRevision, 5);
});

test('dispose publishes pending state once and cancels its timer', () => {
  const h = harness();
  const snapshots = [];
  h.listeners.add(() => snapshots.push(h.getState()));
  h.mutate((state) => ({ ...state, items: ['final'] }));
  h.publisher.markStructureChange();
  h.publisher.emit();
  const timer = h.timers.at(-1);
  h.publisher.dispose();
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], { items: ['final'], structureRevision: 5 });
  assert.equal(timer.cancelled, true);
  assert.equal(h.getCancellations(), 1);
  timer.fn();
  assert.equal(snapshots.length, 1, 'cancelled timer cannot emit after dispose');
});
