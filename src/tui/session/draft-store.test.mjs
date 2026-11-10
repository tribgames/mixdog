import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionDraftStore } from './draft-store.mjs';

const seed = (extra = {}) => ({
  items: [],
  structureRevision: 0,
  busy: false,
  commandBusy: false,
  commandStatus: null,
  toolApproval: null,
  stats: { tokens: 1 },
  ...extra,
});

function createStore(extra = {}) {
  const draft = { state: seed(extra) };
  const listeners = new Set();
  const released = [];
  const store = createSessionDraftStore({
    draft,
    listeners,
    isDisposed: () => false,
    onBusyReleased: () => released.push(Date.now()),
  });
  return { draft, listeners, released, store };
}

test('the published snapshot is frozen and detached from the draft', () => {
  const { draft, store } = createStore();
  assert.ok(Object.isFrozen(store.getPublishedState()));
  assert.notEqual(draft.state, store.getPublishedState());
  assert.notEqual(draft.state.stats, store.getPublishedState().stats);
  assert.deepEqual(draft.state.stats, { tokens: 1 });
});

test('set() ignores no-op patches and applies changed keys to the draft only', async () => {
  const { draft, store, listeners } = createStore();
  let notified = 0;
  listeners.add(() => notified++);
  assert.equal(store.set({ busy: false }), false);
  assert.equal(store.set(null), false);
  assert.equal(store.set({ busy: true }), true);
  assert.equal(draft.state.busy, true);
  assert.equal(store.getPublishedState().busy, false);
  store.flushEmit();
  assert.equal(store.getPublishedState().busy, true);
  assert.equal(notified, 1);
});

test('set() defers structureRevision to the frame boundary', () => {
  const { draft, store } = createStore();
  assert.equal(store.set({ structureRevision: 5 }), true);
  assert.equal(draft.state.structureRevision, 0);
  store.flushEmit();
  assert.equal(store.getPublishedState().structureRevision, 1);
  assert.equal(store.set({ structureRevision: 1 }), false);
});

test('commandStatus / toolApproval patches publish on the microtask boundary', async () => {
  const { store } = createStore();
  store.set({ commandStatus: 'loading' });
  assert.equal(store.getPublishedState().commandStatus, null);
  await Promise.resolve();
  assert.equal(store.getPublishedState().commandStatus, 'loading');
});

test('releasing busy or commandBusy kicks onBusyReleased once per release', async () => {
  const { store, released } = createStore({ busy: true, commandBusy: true });
  store.set({ busy: false });
  store.set({ busy: false });
  store.set({ commandBusy: false });
  assert.equal(released.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released.length, 2);
});
