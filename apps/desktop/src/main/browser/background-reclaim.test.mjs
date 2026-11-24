import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundReclaimer } from './background-reclaim.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { BACKGROUND_PAGE_IDLE_MS, FINISHED_TURN_PAGE_IDLE_MS } from './tab-policy.ts';

function harness() {
  const sessions = new BrowserSessionRegistry();
  const clock = { now: 1_000 };
  const closed = [];
  const busy = new Set();
  const unfinished = new Set();
  const reclaimer = createBackgroundReclaimer({
    sessions,
    now: () => clock.now,
    isBackgroundBusy: (sessionId, name) => busy.has(`${sessionId}/${name}`),
    holdsUnfinishedWork: (_sessionId, guest) => unfinished.has(guest),
    close: (sessionId, name, entry) => {
      closed.push(`${sessionId}/${name}`);
      sessions.deleteBackgroundPage(sessionId, name, entry);
    },
  });
  let nextId = 0;
  const add = (sessionId, name, extra = {}) => {
    const guest = { id: ++nextId, isDestroyed: () => false };
    const entry = { window: { isDestroyed: () => false }, guest, lastUsedAt: 100, kind: 'agent', ...extra };
    sessions.setBackgroundPage(sessionId, name, entry);
    return entry;
  };
  const finish = (sessionId, at = clock.now) => {
    clock.now = at;
    sessions.beginTurn(sessionId, 1);
    sessions.finishTurn(sessionId, 1, at);
  };
  return { sessions, clock, closed, busy, unfinished, reclaimer, add, finish };
}

/** 23 pages of kept sessions, leaving one slot below the 24-page ceiling. */
function fillKept(h) {
  for (const [session, count] of [
    ['k0', 6],
    ['k1', 6],
    ['k2', 6],
    ['k3', 5],
  ]) {
    for (let index = 0; index < count; index++) h.add(session, `p${index}`, { keepAlive: true });
  }
}

test('a session may hold six background pages; the error names its count', () => {
  const h = harness();
  for (let index = 0; index < 5; index++) h.add('mine', `p${index}`);
  assert.doesNotThrow(() => h.reclaimer.admit('mine'));
  h.add('mine', 'p5');
  assert.throws(
    () => h.reclaimer.admit('mine'),
    /this session already has 6 background tabs open \(at most 6 per session\)/
  );
  assert.doesNotThrow(() => h.reclaimer.admit('someone-else'));
});

test('a finished turn reclaims its pages exactly at its idle deadline', () => {
  const h = harness();
  h.add('s', 'a');
  h.finish('s', 10_000);
  h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS - 1);
  assert.deepEqual(h.closed, []);
  h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS);
  assert.deepEqual(h.closed, ['s/a']);
});

test('pages of a live turn wait for the 30-minute idle fallback', () => {
  const h = harness();
  h.add('s', 'a');
  h.sessions.beginTurn('s', 1);
  h.clock.now = 100 + FINISHED_TURN_PAGE_IDLE_MS + 1;
  h.reclaimer.sweep();
  assert.deepEqual(h.closed, []);
  h.clock.now = 100 + BACKGROUND_PAGE_IDLE_MS;
  h.reclaimer.sweep();
  assert.deepEqual(h.closed, ['s/a']);
});

test('at the ceiling the least recently used idle page of a finished session is evicted', () => {
  const h = harness();
  fillKept(h);
  h.add('newer', 'p', { lastUsedAt: 60 });
  h.add('old', 'p', { lastUsedAt: 50 });
  h.add('live', 'p', { lastUsedAt: 10 });
  h.finish('newer');
  h.finish('old');
  h.sessions.beginTurn('live', 1);
  h.sessions.deleteBackgroundPage('k3', 'p4');
  h.sessions.deleteBackgroundPage('k3', 'p3');
  assert.equal(h.sessions.backgroundCount(), 24);
  h.reclaimer.admit('req');
  assert.deepEqual(h.closed, ['old/p']);
  assert.equal(h.sessions.backgroundCount(), 23);
});

const exclusions = {
  'a user page': (_h, entry) => Object.assign(entry, { kind: 'user' }),
  'a popup': (_h, entry) => Object.assign(entry, { kind: 'popup' }),
  'a retained page': (_h, entry) => Object.assign(entry, { keepAlive: true }),
  'a revealed foreground page': (h, entry) => h.sessions.selectGuest('other', entry.guest),
  'a page mid-command': (h) => h.busy.add('other/p'),
  'a page holding unfinished work': (h, entry) => h.unfinished.add(entry.guest),
};

for (const [label, apply] of Object.entries(exclusions)) {
  test(`${label} is never reclaimed or evicted, and the error names its owner`, () => {
    const h = harness();
    fillKept(h);
    const entry = h.add('other', 'p', { lastUsedAt: 50 });
    apply(h, entry);
    h.finish('other', 10_000);
    h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS);
    h.reclaimer.sweep(10_000 + BACKGROUND_PAGE_IDLE_MS + 1);
    assert.deepEqual(h.closed, []);
    assert.throws(
      () => h.reclaimer.admit('req', 1, 10_000 + 10 * 60_000),
      /at most 24 background tabs.*session other "p" \(.+, idle 10m\)/
    );
    assert.deepEqual(h.closed, []);
  });
}

test('a new turn that only reasons keeps the previous turn pages out of reclaim and eviction', () => {
  const h = harness();
  fillKept(h);
  h.add('other', 'p', { lastUsedAt: 10_000 });
  h.finish('other', 10_000);
  // The runtime's turn-start message: no browser command follows.
  h.sessions.beginTurn('other', 2);
  h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS + 1);
  assert.deepEqual(h.closed, []);
  assert.throws(() => h.reclaimer.admit('req', 1, 10_000 + 4 * 60_000), /session other "p" \(turn in progress/);
  // The turn ending starts the wait again.
  h.sessions.finishTurn('other', 2, 300_000);
  h.reclaimer.sweep(300_000 + FINISHED_TURN_PAGE_IDLE_MS - 1);
  assert.deepEqual(h.closed, []);
});

test('any command of the session, even without a turn id, makes its finished pages live again', () => {
  const h = harness();
  h.add('s', 'a');
  h.finish('s', 10_000);
  h.sessions.beginTurn('s', 0);
  h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS);
  assert.deepEqual(h.closed, []);
});

test('a live turn is never evicted for another session', () => {
  const h = harness();
  fillKept(h);
  h.add('other', 'p', { lastUsedAt: 50 });
  h.sessions.beginTurn('other', 1);
  assert.throws(() => h.reclaimer.admit('req'), /session other "p" \(turn in progress/);
});
