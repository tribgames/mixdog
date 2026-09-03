import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertBackgroundTabCapacity,
  backgroundPageIdle,
  BACKGROUND_PAGE_IDLE_MS,
  MAX_BACKGROUND_TABS,
  normalizeBackgroundTabName,
  selectAndRefreshActiveBrowserGuest,
  selectActiveBrowserGuest,
} from './tab-policy.ts';

test('background browser tab names are bounded and cannot impersonate visible tabs', () => {
  assert.equal(normalizeBackgroundTabName(''), 'bg');
  assert.equal(normalizeBackgroundTabName(' research '), 'research');
  assert.throws(
    () => normalizeBackgroundTabName('', { required: true }),
    /background tab name is required/,
  );
  assert.throws(() => normalizeBackgroundTabName('v2'), /reserved p1\/p2.*v1\/v2/);
  assert.throws(() => normalizeBackgroundTabName('p2'), /reserved p1\/p2/);
  assert.throws(() => normalizeBackgroundTabName('bad\nname'), /control characters/);
  assert.throws(() => normalizeBackgroundTabName('x'.repeat(65)), /64 characters/);
  assert.doesNotThrow(() => assertBackgroundTabCapacity(MAX_BACKGROUND_TABS - 1));
  assert.throws(() => assertBackgroundTabCapacity(MAX_BACKGROUND_TABS), /close_tab/);
});

test('background browser pages become reclaimable only after the idle deadline', () => {
  const lastUsedAt = 1_000;
  assert.equal(backgroundPageIdle(lastUsedAt, lastUsedAt + BACKGROUND_PAGE_IDLE_MS - 1), false);
  assert.equal(backgroundPageIdle(lastUsedAt, lastUsedAt + BACKGROUND_PAGE_IDLE_MS), true);
});

test('focused browser guest selection follows explicit activity without arbitrary fallback', () => {
  const alpha = { id: 1, destroyed: false, isDestroyed() { return this.destroyed; } };
  const beta = { id: 2, destroyed: false, isDestroyed() { return this.destroyed; } };
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
    isDestroyed() { return this.destroyed; },
    invalidate() { this.repaints += 1; },
  };
  const beta = {
    id: 2,
    destroyed: false,
    repaints: 0,
    isDestroyed() { return this.destroyed; },
    invalidate() { this.repaints += 1; },
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
