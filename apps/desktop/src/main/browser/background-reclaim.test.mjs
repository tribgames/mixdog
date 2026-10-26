import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundReclaimer } from './background-reclaim.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { BACKGROUND_PAGE_IDLE_MS, FINISHED_TURN_PAGE_IDLE_MS } from './tab-policy.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const sessions = new BrowserSessionRegistry();
  const clock = { now: 1_000 };
  const closed = [];
  const busy = new Set();
  const unfinished = new Set();
  const edited = new Set();
  const slow = { on: false, answers: [] };
  const reclaimer = createBackgroundReclaimer({
    sessions,
    now: () => clock.now,
    isBackgroundBusy: (sessionId, name) => busy.has(`${sessionId}/${name}`),
    holdsUnfinishedWork: (guest) => unfinished.has(guest),
    documentGeneration: () => 0,
    hasEditedFields: (guest) =>
      slow.on
        ? new Promise((resolve) => slow.answers.push(() => resolve(edited.has(guest))))
        : Promise.resolve(edited.has(guest)),
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
  const finish = async (sessionId, at = clock.now) => {
    clock.now = at;
    sessions.beginTurn(sessionId, 1);
    sessions.finishTurn(sessionId, 1, at);
    await flush();
  };
  return { sessions, clock, closed, busy, unfinished, edited, slow, reclaimer, add, finish };
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

test('a finished turn reclaims its pages exactly five minutes later', async () => {
  const h = harness();
  h.add('s', 'a');
  await h.finish('s', 10_000);
  h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS - 1);
  await flush();
  assert.deepEqual(h.closed, []);
  h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS);
  assert.deepEqual(h.closed, ['s/a']);
});

test('pages of a live turn wait for the 30-minute idle fallback', async () => {
  const h = harness();
  h.add('s', 'a');
  h.sessions.beginTurn('s', 1);
  h.clock.now = 100 + FINISHED_TURN_PAGE_IDLE_MS + 1;
  h.reclaimer.sweep();
  await flush();
  assert.deepEqual(h.closed, []);
  h.clock.now = 100 + BACKGROUND_PAGE_IDLE_MS;
  h.reclaimer.sweep();
  await flush();
  assert.deepEqual(h.closed, ['s/a']);
});

test('at the ceiling the least recently used idle page of a finished session is evicted', async () => {
  const h = harness();
  fillKept(h);
  h.add('newer', 'p', { lastUsedAt: 60 });
  h.add('old', 'p', { lastUsedAt: 50 });
  h.add('live', 'p', { lastUsedAt: 10 });
  await h.finish('newer');
  await h.finish('old');
  h.sessions.beginTurn('live', 1);
  h.sessions.deleteBackgroundPage('k3', 'p4');
  h.sessions.deleteBackgroundPage('k3', 'p3');
  assert.equal(h.sessions.backgroundCount(), 24);
  h.reclaimer.admit('req');
  assert.deepEqual(h.closed, ['old/p']);
  assert.equal(h.sessions.backgroundCount(), 23);
});

const exclusions = {
  'a user page': (h, entry) => Object.assign(entry, { kind: 'user' }),
  'a popup': (h, entry) => Object.assign(entry, { kind: 'popup' }),
  'a retained page': (h, entry) => Object.assign(entry, { keepAlive: true }),
  'a revealed foreground page': (h, entry) => h.sessions.selectGuest('other', entry.guest),
  'a page mid-command': (h) => h.busy.add('other/p'),
  'a page holding sign-in or typed input': (h, entry) => h.unfinished.add(entry.guest),
  'a page with an unsubmitted form': (h, entry) => h.edited.add(entry.guest),
};

for (const [label, apply] of Object.entries(exclusions)) {
  test(`${label} is never reclaimed or evicted, and the error names its owner`, async () => {
    const h = harness();
    fillKept(h);
    const entry = h.add('other', 'p', { lastUsedAt: 50 });
    apply(h, entry);
    await h.finish('other', 10_000);
    h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS);
    await flush();
    h.reclaimer.sweep(10_000 + BACKGROUND_PAGE_IDLE_MS + 1);
    await flush();
    assert.deepEqual(h.closed, []);
    assert.throws(
      () => h.reclaimer.admit('req', 1, 10_000 + 10 * 60_000),
      /at most 24 background tabs.*session other "p" \(.+, idle 10m\)/
    );
    assert.deepEqual(h.closed, []);
  });
}

test('a new turn that only reasons keeps the previous turn pages out of reclaim and eviction', async () => {
  const h = harness();
  fillKept(h);
  h.add('other', 'p', { lastUsedAt: 50 });
  await h.finish('other', 10_000);
  // The runtime's turn-start message: no browser command follows.
  h.sessions.beginTurn('other', 2);
  h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS + 1);
  await flush();
  assert.deepEqual(h.closed, []);
  assert.throws(() => h.reclaimer.admit('req', 1, 10_000 + 10 * 60_000), /session other "p" \(turn in progress/);
  // The turn ending starts the five minutes again.
  await h.finish('other', 700_000);
  h.reclaimer.sweep(700_000 + FINISHED_TURN_PAGE_IDLE_MS - 1);
  assert.deepEqual(h.closed, []);
});

test('any command of the session, even without a turn id, makes its finished pages live again', async () => {
  const h = harness();
  h.add('s', 'a');
  await h.finish('s', 10_000);
  h.sessions.beginTurn('s', 0);
  h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS);
  await flush();
  assert.deepEqual(h.closed, []);
});

test('activity during a slow form probe discards its answer', async () => {
  const h = harness();
  const entry = h.add('s', 'a');
  h.slow.on = true;
  await h.finish('s', 10_000);
  assert.equal(h.slow.answers.length, 1);
  // The page is used while the probe is still out, then the probe answers "unedited" much later.
  entry.lastUsedAt = 10_100;
  h.clock.now = 10_000 + 6 * 60_000;
  h.slow.answers.shift()();
  await flush();
  // What the page holds changed after that answer was read.
  h.edited.add(entry.guest);
  h.slow.on = false;
  h.reclaimer.sweep(10_000 + FINISHED_TURN_PAGE_IDLE_MS);
  assert.deepEqual(h.closed, [], 'the stale "unedited" answer is not trusted as current');
  await flush();
  assert.deepEqual(h.closed, [], 'the fresh probe sees the edit');
});

test('a command during a slow probe keeps the page from being evicted on the old answer', async () => {
  const h = harness();
  fillKept(h);
  h.add('other', 'p', { lastUsedAt: 50 });
  h.slow.on = true;
  await h.finish('other', 10_000);
  h.sessions.beginTurn('other', 0);
  h.slow.answers.shift()();
  await flush();
  assert.throws(() => h.reclaimer.admit('req', 1, 10_000), /session other "p"/);
  assert.deepEqual(h.closed, []);
});

test('a live turn is never evicted for another session', () => {
  const h = harness();
  fillKept(h);
  h.add('other', 'p', { lastUsedAt: 50 });
  h.sessions.beginTurn('other', 1);
  assert.throws(() => h.reclaimer.admit('req'), /session other "p" \(turn in progress/);
});

test('a page whose form was not checked after its turn is not evicted', () => {
  const h = harness();
  fillKept(h);
  h.add('other', 'p', { lastUsedAt: 50 });
  h.sessions.finishTurn('other', 1, 5_000);
  // The finish listener probed asynchronously; before that resolves it is unchecked.
  assert.throws(() => h.reclaimer.admit('req'), /form state not checked yet/);
});
