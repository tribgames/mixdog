import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionLaneStore } from './session-lane-store.ts';

const decorator = {
  decorate: (snapshot) => snapshot,
  clear() {},
};

test('inactive lane updates do not retain notification keys', () => {
  const store = createSessionLaneStore({ maxEntries: 8, decorator });
  for (let index = 0; index < 40; index += 1) {
    store.apply({
      sessionId: `session-${index}`,
      snapshot: { sessionId: `session-${index}`, items: [] },
      frameSource: 'session.read',
    });
  }
  assert.equal(store.stats().entries, 8);
  assert.equal(store.stats().subscribedSessions, 0);
  assert.equal(store.stats().notificationKeys, 0);
});

test('a daemon eviction or transport loss keeps the cached lane', () => {
  const store = createSessionLaneStore({ decorator });
  const seen = [];
  store.subscribe('session', () => { seen.push(store.get('session')); });
  const snapshot = { sessionId: 'session', items: [{ id: 'a' }] };
  store.apply({ sessionId: 'session', snapshot, frameSource: 'live' });
  assert.equal(store.get('session'), snapshot);

  // The daemon reclaimed an idle session's memory; the transcript still exists.
  store.apply({
    sessionId: 'session',
    snapshot: null,
    frameSource: 'live',
    laneEnd: 'unloaded',
  });
  assert.equal(store.get('session'), snapshot);

  store.apply({
    sessionId: 'session',
    snapshot: null,
    frameSource: 'live',
    laneEnd: 'disconnected',
  });
  assert.equal(store.get('session'), snapshot);

  // A real teardown still empties the pane.
  store.apply({
    sessionId: 'session',
    snapshot: null,
    frameSource: 'live',
    laneEnd: 'gone',
  });
  assert.equal(store.get('session'), null);
  store.clear();
});

test('a transport baseline release keeps a mounted pane painted', () => {
  const store = createSessionLaneStore({ decorator });
  store.subscribe('session', () => {});
  const snapshot = { sessionId: 'session', items: [{ id: 'a' }] };
  store.apply({ sessionId: 'session', snapshot, frameSource: 'live' });
  assert.equal(store.get('session'), snapshot);

  // The host releases a delta baseline with an UNNAMED null frame whenever a
  // session leaves the visible set (ipc: releaseHiddenSessionStateEntries). One
  // registration that momentarily omits a mounted session used to erase the
  // pane mid-turn; the frame releases a baseline, never the painted content.
  store.apply({ sessionId: 'session', snapshot: null });
  assert.equal(store.get('session'), snapshot);
  store.clear();
});

test('unsubscribing releases a lane notification key', () => {
  const store = createSessionLaneStore({ decorator });
  const unsubscribe = store.subscribe('session', () => {});
  store.apply({
    sessionId: 'session',
    snapshot: { sessionId: 'session', items: [] },
    frameSource: 'session.read',
  });
  assert.equal(store.stats().notificationKeys, 1);
  unsubscribe();
  assert.equal(store.stats().notificationKeys, 0);
  store.clear();
});
