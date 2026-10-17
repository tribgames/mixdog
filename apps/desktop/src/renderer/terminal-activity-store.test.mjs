import assert from 'node:assert/strict';
import test from 'node:test';

const focusCalls = [];
let pushActivity = null;
let readActivity = async () => [{ id: 'a', state: 'running' }];
const events = new EventTarget();
globalThis.window = {
  addEventListener: (name, listener) => events.addEventListener(name, listener),
  removeEventListener: (name, listener) => events.removeEventListener(name, listener),
  mixdogDesktop: {
    termActivity: () => readActivity(),
    termFocus: (id, focused) => focusCalls.push([id, focused]),
    subscribeTermActivity: (listener) => {
      pushActivity = listener;
      return () => {
        pushActivity = null;
      };
    },
  },
};

const store = await import('./terminal-activity-store.ts');

test('the store mirrors the host snapshot and events; unknown terminals have no entry', async () => {
  let changes = 0;
  const unsubscribe = store.subscribeTerminalActivity(() => (changes += 1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getTerminalActivityStates().get('a'), 'running');
  const before = store.getTerminalActivityStates();
  pushActivity({ id: 'a', state: 'finished', completed: { exitCode: 0, durationMs: 1 } });
  assert.notEqual(store.getTerminalActivityStates(), before, 'a new snapshot per change');
  assert.equal(store.getTerminalActivityStates().get('a'), 'finished');
  pushActivity({ id: 'a', state: null });
  assert.equal(store.getTerminalActivityStates().has('a'), false);
  assert.ok(changes >= 3);
  unsubscribe();
  assert.equal(pushActivity, null, 'the last listener detaches from the host');
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A host read the test answers by hand. */
function deferredReads() {
  const pending = [];
  readActivity = () => new Promise((resolve) => pending.push(resolve));
  return pending;
}

test('a reconnecting view re-reads the host on connection-ready and the recovery events, until detached', async () => {
  let reads = 0;
  readActivity = async () => {
    reads += 1;
    return [];
  };
  const unsubscribe = store.subscribeTerminalActivity(() => {});
  await settle();
  pushActivity({ id: 'stale', state: 'running' });
  assert.equal(store.getTerminalActivityStates().get('stale'), 'running');
  for (const name of ['mixdog:remote-connection-ready', 'mixdog:remote-reconnected', 'mixdog:remote-state-gap']) {
    pushActivity({ id: 'stale', state: 'running' });
    events.dispatchEvent(new Event(name));
    await settle();
    assert.equal(store.getTerminalActivityStates().has('stale'), false, `${name} clears the stale dot`);
  }
  assert.equal(reads, 4);
  unsubscribe();
  events.dispatchEvent(new Event('mixdog:remote-connection-ready'));
  await settle();
  assert.equal(reads, 4, 'no listener is left behind');
});

test('a push during a snapshot load wins over that snapshot', async () => {
  const pending = deferredReads();
  const unsubscribe = store.subscribeTerminalActivity(() => {});
  pushActivity({ id: 'x', state: 'finished' });
  pushActivity({ id: 'gone', state: null });
  pending[0]([
    { id: 'x', state: 'running' },
    { id: 'gone', state: 'idle' },
    { id: 'y', state: 'idle' },
  ]);
  await settle();
  const states = store.getTerminalActivityStates();
  assert.equal(states.get('x'), 'finished');
  assert.equal(states.has('gone'), false);
  assert.equal(states.get('y'), 'idle');
  unsubscribe();
});

test('overlapping refreshes: only the newest response applies', async () => {
  const pending = deferredReads();
  const unsubscribe = store.subscribeTerminalActivity(() => {});
  events.dispatchEvent(new Event('focus'));
  assert.equal(pending.length, 2);
  pending[1]([{ id: 'n', state: 'idle' }]);
  await settle();
  pending[0]([
    { id: 'n', state: 'running' },
    { id: 'old', state: 'running' },
  ]);
  await settle();
  const states = store.getTerminalActivityStates();
  assert.equal(states.get('n'), 'idle');
  assert.equal(states.has('old'), false, 'the older response was dropped');
  unsubscribe();
});

test('a push from before the newest request does not override its snapshot', async () => {
  const pending = deferredReads();
  const unsubscribe = store.subscribeTerminalActivity(() => {});
  pushActivity({ id: 'p', state: 'running' });
  events.dispatchEvent(new Event('focus'));
  assert.equal(pending.length, 2);
  pending[1]([{ id: 'p', state: 'idle' }]);
  await settle();
  assert.equal(store.getTerminalActivityStates().get('p'), 'idle');
  unsubscribe();
});

test('focus holds are reference counted, renewed, and re-claim a tab reported finished', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  focusCalls.length = 0;
  const first = store.holdTerminalFocus('b');
  const second = store.holdTerminalFocus('b');
  assert.deepEqual(focusCalls, [['b', true]]);
  t.mock.timers.tick(10_000);
  assert.deepEqual(focusCalls.at(-1), ['b', true], 'renewed before the host lease lapses');
  focusCalls.length = 0;
  store.applyTerminalActivity({ id: 'b', state: 'finished' });
  assert.deepEqual(focusCalls, [['b', true]], 'a focused tab never stays finished');
  first();
  assert.equal(focusCalls.length, 1);
  second();
  assert.deepEqual(focusCalls.at(-1), ['b', false]);
  second();
  assert.equal(focusCalls.length, 2, 'a release is idempotent');
});
