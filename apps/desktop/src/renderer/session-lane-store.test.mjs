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

// Background shell jobs are injected by the desktop host, never by the session
// runtime: a snapshot returned by a runtime call (slash command, model/Fast
// switch, workflow change) omits the field entirely, and adopting it whole
// blanked the live-work card while a shell was still running.
test('a frame that omits shell jobs keeps the last host bucket', () => {
  const store = createSessionLaneStore({ decorator });
  const running = { count: 1, jobs: [{ taskId: 'task-1', command: 'run.ps1', startedAt: 1 }] };
  store.apply({
    sessionId: 'session',
    snapshot: { sessionId: 'session', shellJobs: running },
    frameSource: 'live',
  });
  store.apply({
    sessionId: 'session',
    snapshot: { sessionId: 'session', model: 'gpt-5.6-sol' },
    frameSource: 'live',
  });
  assert.deepEqual(store.get('session').shellJobs, running);
  // A host frame ALWAYS names the bucket, so a finished shell still clears.
  store.apply({
    sessionId: 'session',
    snapshot: { sessionId: 'session', shellJobs: { count: 0, jobs: [] } },
    frameSource: 'live',
  });
  assert.equal(store.get('session').shellJobs.count, 0);
  store.clear();
});

// The session runtime republishes the DERIVED context-window fields as 0 — not
// absent — whenever its own route comparison misses, and a 0 denominator made
// the gauge fall back to its last complete reading: after an auto-compact it
// then froze on the pre-compact number for the rest of the session.
test('a frame that zeroes the context window keeps the last known limit', () => {
  const store = createSessionLaneStore({ decorator });
  store.apply({
    sessionId: 'session',
    snapshot: {
      sessionId: 'session',
      provider: 'anthropic',
      model: 'claude-opus-5',
      stats: { currentEstimatedContextTokens: 258_500 },
      contextWindow: 272_000,
      displayContextWindow: 272_000,
      autoCompactTokenLimit: 272_000,
    },
    frameSource: 'live',
  });
  store.apply({
    sessionId: 'session',
    snapshot: {
      sessionId: 'session',
      provider: 'anthropic',
      model: 'claude-opus-5',
      stats: { currentEstimatedContextTokens: 25_000 },
      contextWindow: 0,
      displayContextWindow: 0,
      autoCompactTokenLimit: 0,
    },
    frameSource: 'live',
  });
  const compacted = store.get('session');
  assert.equal(compacted.autoCompactTokenLimit, 272_000);
  assert.equal(compacted.displayContextWindow, 272_000);
  assert.equal(compacted.stats.currentEstimatedContextTokens, 25_000);

  // A real route change drops the previous window instead of dividing the new
  // model's usage by the old model's limit.
  store.apply({
    sessionId: 'session',
    snapshot: {
      sessionId: 'session',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      stats: { currentEstimatedContextTokens: 25_000 },
      autoCompactTokenLimit: 0,
    },
    frameSource: 'live',
  });
  assert.equal(Number(store.get('session').autoCompactTokenLimit) || 0, 0);
  store.clear();
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
