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
