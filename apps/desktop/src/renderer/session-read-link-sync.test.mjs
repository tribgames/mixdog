import assert from 'node:assert/strict';
import test from 'node:test';
import { requestSessionRead } from './session-read-request.ts';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { setRemoteConnectionState } from './remote-connection-state.ts';

const STATE_EVENT = 'mixdog:remote-connection-state';

/** A window that counts live connection-state listeners and holds timers, so a
 *  test can run a read's deadline on demand. */
class CountingWindow extends EventTarget {
  listeners = 0;
  deadlines = [];
  addEventListener(type, ...rest) {
    if (type === STATE_EVENT) this.listeners += 1;
    super.addEventListener(type, ...rest);
  }
  removeEventListener(type, ...rest) {
    if (type === STATE_EVENT) this.listeners -= 1;
    super.removeEventListener(type, ...rest);
  }
  setTimeout = (callback, ms) => (ms > 1_000 ? this.deadlines.push(callback) : setTimeout(callback, ms));
  clearTimeout = clearTimeout;
}

function fixture(t, { remote = true, state = 'syncing', prefetchSession }) {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const win = Object.assign(new CountingWindow(), {
    Event,
    mixdogDesktop: { prefetchSession },
    ...(remote ? { mixdogRemoteServer: 'https://relay.example' } : {}),
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { dataset: {} } },
  });
  defaultSessionLaneStore.clear();
  if (state) setRemoteConnectionState(state);
  t.after(() => {
    defaultSessionLaneStore.clear();
    for (const [name, prior] of [
      ['window', priorWindow],
      ['document', priorDocument],
    ]) {
      if (prior) Object.defineProperty(globalThis, name, prior);
      else delete globalThis[name];
    }
  });
  return win;
}

const deliverLane = (sessionId) =>
  defaultSessionLaneStore.apply({
    sessionId,
    frameSource: 'replay',
    snapshot: { sessionId, items: [{ id: 'm1', kind: 'assistant', text: 'hello' }] },
  });

test('after a reload the pane read waits for the view sync, which delivered the transcript: no second fetch', async (t) => {
  const calls = [];
  fixture(t, { prefetchSession: async (id) => calls.push(id) > 0 });
  const read = requestSessionRead('restored');
  assert.deepEqual(calls, [], 'held while the link synchronizes');
  deliverLane('restored');
  setRemoteConnectionState('connected');
  assert.equal(await read, true);
  assert.deepEqual(calls, [], 'the sync already carried the transcript');
});

test('a sync that left the lane empty still gets the normal read once connected', async (t) => {
  const calls = [];
  fixture(t, { state: 'connecting', prefetchSession: async (id) => calls.push(id) > 0 });
  const read = requestSessionRead('missed');
  setRemoteConnectionState('syncing');
  assert.deepEqual(calls, []);
  setRemoteConnectionState('connected');
  assert.equal(await read, true);
  assert.deepEqual(calls, ['missed']);
});

test('a connected remote link reads at once, as before', async (t) => {
  const calls = [];
  fixture(t, { state: 'connected', prefetchSession: async (id) => calls.push(id) > 0 });
  assert.equal(await requestSessionRead('cold'), true);
  assert.deepEqual(calls, ['cold']);
});

test('a refresh read is never held back by the sync', async (t) => {
  const calls = [];
  fixture(t, { state: 'reconnecting', prefetchSession: async (id) => calls.push(id) > 0 });
  deliverLane('gap');
  assert.equal(await requestSessionRead('gap', { refresh: true }), true);
  assert.deepEqual(calls, ['gap']);
});

test('an offline read releases its listener at the deadline, so retries never pile up', async (t) => {
  const calls = [];
  const win = fixture(t, { state: 'connecting', prefetchSession: async (id) => calls.push(id) > 0 });
  for (let retry = 1; retry <= 3; retry += 1) {
    const read = requestSessionRead('offline');
    assert.equal(win.listeners, 1, 'one wait per live read');
    win.deadlines.at(-1)();
    assert.equal(await read, false);
    assert.equal(win.listeners, 0, `released at deadline ${retry}`);
  }
  setRemoteConnectionState('connected');
  assert.deepEqual(calls, [], 'an expired read never fetches after the link returns');
});

test('a read nobody waits for any more is dropped while it waits for the link', async (t) => {
  const calls = [];
  const win = fixture(t, { prefetchSession: async (id) => calls.push(id) > 0 });
  const pane = new AbortController();
  const read = requestSessionRead('unmounted', { signal: pane.signal });
  assert.equal(win.listeners, 1);
  pane.abort();
  assert.equal(await read, false);
  assert.equal(win.listeners, 0, 'released when its only asker went away');
  deliverLane('unmounted');
  setRemoteConnectionState('connected');
  assert.deepEqual(calls, []);
});

test('a shared wait stays until its last asker goes away', async (t) => {
  const calls = [];
  const win = fixture(t, { prefetchSession: async (id) => calls.push(id) > 0 });
  const first = new AbortController();
  const second = new AbortController();
  const a = requestSessionRead('shared', { signal: first.signal });
  const b = requestSessionRead('shared', { signal: second.signal });
  assert.equal(win.listeners, 1, 'the second asker joined the same wait');
  first.abort();
  assert.equal(win.listeners, 1, 'still wanted by the second');
  deliverLane('shared');
  setRemoteConnectionState('connected');
  assert.equal(await b, true);
  assert.equal(await a, true, 'one shared result');
  assert.equal(win.listeners, 0);
  assert.deepEqual(calls, []);
});

test('a synchronous unmount→remount (StrictMode) neither joins the dropped wait nor fetches while syncing', async (t) => {
  const calls = [];
  const win = fixture(t, { prefetchSession: async (id) => calls.push(id) > 0 });
  const first = new AbortController();
  const dropped = requestSessionRead('strict', { signal: first.signal });
  first.abort();
  const second = new AbortController();
  const remounted = requestSessionRead('strict', { signal: second.signal });
  assert.notEqual(remounted, dropped, 'the abandoned read is no longer joinable');
  assert.equal(win.listeners, 1, 'only the remount waits');
  assert.equal(await dropped, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [], 'still syncing: nothing is fetched');
  deliverLane('strict');
  setRemoteConnectionState('connected');
  assert.equal(await remounted, true);
  assert.deepEqual(calls, []);
  assert.equal(win.listeners, 0);
});

test('a remount after the dropped read ended but before its cleanup gets a read of its own', async (t) => {
  const calls = [];
  const win = fixture(t, { prefetchSession: async (id) => calls.push(id) > 0 });
  const first = new AbortController();
  const dropped = requestSessionRead('late', { signal: first.signal });
  first.abort();
  assert.equal(await dropped, false, 'the continuation returned');
  const second = new AbortController();
  const remounted = requestSessionRead('late', { signal: second.signal });
  assert.notEqual(remounted, dropped);
  assert.equal(win.listeners, 1);
  assert.deepEqual(calls, [], 'still syncing: nothing is fetched');
  setRemoteConnectionState('connected');
  assert.equal(await remounted, true, 'the sync left no lane, so the remount fetched');
  assert.deepEqual(calls, ['late']);
  assert.equal(win.listeners, 0);
});

test('a signal-less asker keeps the shared wait alive when the pane goes away', async (t) => {
  const calls = [];
  const win = fixture(t, { prefetchSession: async (id) => calls.push(id) > 0 });
  const pane = new AbortController();
  const warm = requestSessionRead('kept');
  void requestSessionRead('kept', { signal: pane.signal });
  pane.abort();
  assert.equal(win.listeners, 1);
  deliverLane('kept');
  setRemoteConnectionState('connected');
  assert.equal(await warm, true);
});

test('a refresh that joins a read waiting for the link still fetches', async (t) => {
  const calls = [];
  const win = fixture(t, { prefetchSession: async (id) => calls.push(id) > 0 });
  const normal = requestSessionRead('gap');
  const refresh = requestSessionRead('gap', { refresh: true });
  assert.equal(win.listeners, 1, 'one shared wait');
  deliverLane('gap');
  setRemoteConnectionState('connected');
  assert.equal(await normal, true);
  assert.equal(await refresh, true);
  assert.deepEqual(calls, ['gap'], 'the sync landed a lane, yet the refresh fetched it again');
});

test('a native window never waits on a connection state', async (t) => {
  const calls = [];
  fixture(t, { remote: false, state: 'syncing', prefetchSession: async (id) => calls.push(id) > 0 });
  assert.equal(await requestSessionRead('native'), true);
  assert.deepEqual(calls, ['native']);
});
