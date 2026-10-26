import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backgroundPageIdle,
  BACKGROUND_PAGE_IDLE_MS,
  FINISHED_TURN_PAGE_IDLE_MS,
  MAX_BACKGROUND_TABS_GLOBAL,
  MAX_BACKGROUND_TABS_PER_SESSION,
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

test('limits are six per session, 24 overall, and a finished turn reclaims after five minutes', () => {
  assert.equal(MAX_BACKGROUND_TABS_PER_SESSION, 6);
  assert.equal(MAX_BACKGROUND_TABS_GLOBAL, 24);
  assert.equal(FINISHED_TURN_PAGE_IDLE_MS, 5 * 60_000);
  assert.equal(BACKGROUND_PAGE_IDLE_MS, 30 * 60_000);
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
      assert.match(error.message, /more/);
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
