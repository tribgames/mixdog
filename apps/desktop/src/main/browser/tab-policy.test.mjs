import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundReclaimer } from './background-reclaim.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import {
  backgroundPageIdle,
  BACKGROUND_PAGE_IDLE_MS,
  normalizeBackgroundTabName,
  planBackgroundAdmission,
  selectAndRefreshActiveBrowserGuest,
  selectActiveBrowserGuest,
} from './tab-policy.ts';

test('background browser tab names are bounded and cannot impersonate visible tabs', () => {
  assert.equal(normalizeBackgroundTabName(''), 'bg');
  assert.equal(normalizeBackgroundTabName(' research '), 'research');
  assert.throws(() => normalizeBackgroundTabName('', { required: true }), /background tab name is required/);
  assert.throws(() => normalizeBackgroundTabName('v2'), /reserved p1\/p2.*v1\/v2/);
  assert.throws(() => normalizeBackgroundTabName('p2'), /reserved p1\/p2/);
  assert.throws(() => normalizeBackgroundTabName('bad\nname'), /control characters/);
  assert.throws(() => normalizeBackgroundTabName('x'.repeat(65)), /64 characters/);
});

const facts = (sessionId, count, extra = {}) =>
  Array.from({ length: count }, (_, index) => ({
    sessionId,
    name: `${sessionId}-${index}`,
    lastUsedAt: 1_000 + index,
    blocker: '',
    ...extra,
  }));

// Would fail if a finished turn's idle pages were reclaimed sooner or later than 5 minutes after the turn ended,
// or if a live turn's idle pages were reclaimed sooner or later than 30 minutes. The deadlines are literals on
// purpose: importing the policy constants would move with the product and prove nothing.
test('idle pages close five minutes after their turn finished, or after thirty minutes while it is live', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const sessions = new BrowserSessionRegistry();
  const closed = [];
  const clock = { now: 0 };
  const reclaimer = createBackgroundReclaimer({
    sessions,
    now: () => clock.now,
    isBackgroundBusy: () => false,
    holdsUnfinishedWork: () => false,
    documentGeneration: () => 0,
    hasEditedFields: () => Promise.resolve(false),
    close: (sessionId, name, entry) => {
      closed.push(`${sessionId}/${name}`);
      sessions.deleteBackgroundPage(sessionId, name, entry);
    },
  });
  let guestId = 0;
  const addPage = (sessionId, name, lastUsedAt) =>
    sessions.setBackgroundPage(sessionId, name, {
      window: { isDestroyed: () => false },
      guest: { id: ++guestId, isDestroyed: () => false },
      lastUsedAt,
      kind: 'agent',
    });
  const minutes = (count) => count * 60_000;

  // The page was last used at minute 1 and the turn finished at minute 10: the finished-turn deadline must count
  // from the turn's finish (minute 15), not from the page's last use (minute 6).
  const finishedAt = minutes(10);
  addPage('finished', 'page', minutes(1));
  sessions.beginTurn('finished', 1);
  sessions.finishTurn('finished', 1, finishedAt);
  addPage('live', 'page', minutes(1));
  sessions.beginTurn('live', 1);
  await flush();

  clock.now = finishedAt + minutes(5) - 1;
  reclaimer.sweep();
  await flush();
  assert.deepEqual(closed, [], 'just before five minutes after the turn finished nothing closes');
  clock.now = finishedAt + minutes(5);
  reclaimer.sweep();
  await flush();
  assert.deepEqual(closed, ['finished/page'], 'five minutes after the turn finished only its page closes');
  clock.now = minutes(1) + minutes(30) - 1;
  reclaimer.sweep();
  await flush();
  assert.deepEqual(closed, ['finished/page'], 'a live turn page outlasts five minutes');
  clock.now = minutes(1) + minutes(30);
  reclaimer.sweep();
  await flush();
  assert.deepEqual(closed, ['finished/page', 'live/page'], 'thirty minutes after its last use the live page closes');
});

test('a session at its own cap is told its count and to close its own tabs', () => {
  const pages = [...facts('a', 6), ...facts('b', 2)];
  assert.deepEqual(planBackgroundAdmission({ sessionId: 'b', adding: 1, pages, now: 5_000 }), []);
  assert.throws(
    () => planBackgroundAdmission({ sessionId: 'a', adding: 1, pages, now: 5_000 }),
    /this session already has 6 background tabs open \(at most 6 per session\).*close_tab/
  );
  assert.throws(() => planBackgroundAdmission({ sessionId: 'b', adding: 5, pages, now: 5_000 }), /already has 2/);
});

test('at the global ceiling the least recently used evictable page of another session goes', () => {
  const pages = [
    ...facts('a', 6),
    ...facts('b', 6),
    ...facts('c', 6),
    ...facts('d', 4),
    { sessionId: 'e', name: 'old', lastUsedAt: 10, blocker: '' },
    { sessionId: 'e', name: 'older', lastUsedAt: 5, blocker: 'turn in progress' },
  ];
  assert.equal(pages.length, 24);
  assert.deepEqual(planBackgroundAdmission({ sessionId: 'd', adding: 1, pages, now: 5_000 }), [
    { sessionId: 'e', name: 'old' },
  ]);
  // The requester's own pages are never the victims.
  const ownOnly = [
    ...facts('a', 6, { blocker: 'kept for the user' }),
    ...facts('b', 6, { blocker: 'kept for the user' }),
    ...facts('c', 6, { blocker: 'kept for the user' }),
    ...facts('d', 5),
    { sessionId: 'e', name: 'held', lastUsedAt: 1, blocker: 'turn in progress' },
  ];
  assert.throws(
    () => planBackgroundAdmission({ sessionId: 'd', adding: 1, pages: ownOnly, now: 5_000 }),
    /none can be reclaimed/
  );
});

test('nothing evictable lists the blocking owners with idle ages', () => {
  const pages = [
    { sessionId: 'live-turn', name: 'research', lastUsedAt: 1_000, blocker: 'turn in progress' },
    { sessionId: 'form-owner', name: 'checkout', lastUsedAt: 1_000 + 7 * 60_000, blocker: 'unsubmitted form input' },
    ...facts('a', 6),
    ...facts('b', 6),
    ...facts('c', 6),
    ...facts('x', 4),
  ].map((page) =>
    ['a', 'b', 'c', 'x'].includes(page.sessionId)
      ? { ...page, lastUsedAt: 9_000_000, blocker: 'kept for the user' }
      : page
  );
  assert.equal(pages.length, 24);
  assert.throws(
    () => planBackgroundAdmission({ sessionId: 'new', adding: 1, pages, now: 1_000 + 10 * 60_000 }),
    (error) => {
      assert.match(error.message, /at most 24 background tabs/);
      assert.match(error.message, /session live-turn "research" \(turn in progress, idle 10m\)/);
      assert.match(error.message, /session form-owner "checkout" \(unsubmitted form input, idle 3m\)/);
      assert.equal(error.message.match(/session \S+ "/g).length, 24, 'every blocking page is named');
      assert.doesNotMatch(error.message, /\d+ more/);
      assert.doesNotMatch(error.message, /call list_tabs and close_tab/);
      return true;
    }
  );
});

test('background browser pages become reclaimable only after the idle deadline', () => {
  const lastUsedAt = 1_000;
  assert.equal(backgroundPageIdle(lastUsedAt, lastUsedAt + BACKGROUND_PAGE_IDLE_MS - 1), false);
  assert.equal(backgroundPageIdle(lastUsedAt, lastUsedAt + BACKGROUND_PAGE_IDLE_MS), true);
});

test('focused browser guest selection follows explicit activity without arbitrary fallback', () => {
  const alpha = {
    id: 1,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  const beta = {
    id: 2,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  const guests = new Set([alpha, beta]);
  let current = selectActiveBrowserGuest(guests, null, alpha.id, true);
  assert.equal(current, alpha);
  current = selectActiveBrowserGuest(guests, current, beta.id, false);
  assert.equal(current, alpha);
  current = selectActiveBrowserGuest(guests, current, beta.id, true);
  assert.equal(current, beta);
  current = selectActiveBrowserGuest(guests, current, beta.id, false);
  assert.equal(current, null);
  current = selectActiveBrowserGuest(guests, current, 999, true);
  assert.equal(current, null);
  alpha.destroyed = true;
  current = selectActiveBrowserGuest(guests, alpha, beta.id, false);
  assert.equal(current, null);
});

test('active browser guest repaints on activation and foreground return', () => {
  const alpha = {
    id: 1,
    destroyed: false,
    repaints: 0,
    isDestroyed() {
      return this.destroyed;
    },
    invalidate() {
      this.repaints += 1;
    },
  };
  const beta = {
    id: 2,
    destroyed: false,
    repaints: 0,
    isDestroyed() {
      return this.destroyed;
    },
    invalidate() {
      this.repaints += 1;
    },
  };
  const guests = new Set([alpha, beta]);
  let current = selectAndRefreshActiveBrowserGuest(guests, null, alpha.id, true);
  assert.equal(current, alpha);
  assert.equal(alpha.repaints, 1);

  current = selectAndRefreshActiveBrowserGuest(guests, current, alpha.id, true);
  assert.equal(current, alpha);
  assert.equal(alpha.repaints, 2);

  current = selectAndRefreshActiveBrowserGuest(guests, current, beta.id, false);
  assert.equal(current, alpha);
  assert.equal(beta.repaints, 0);

  current = selectAndRefreshActiveBrowserGuest(guests, current, beta.id, true);
  assert.equal(current, beta);
  assert.equal(beta.repaints, 1);
});
