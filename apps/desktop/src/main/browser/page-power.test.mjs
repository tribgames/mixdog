import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserPagePower, reclaimIdleUserSessions } from './page-power.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { BACKGROUND_PAGE_IDLE_MS, USER_PAGE_IDLE_MS } from './tab-policy.ts';

function guest(id) {
  return {
    id,
    log: [],
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    isOffscreen: () => true,
    setBackgroundThrottling(allowed) {
      this.log.push(`throttle:${allowed}`);
    },
    startPainting() {
      this.log.push('start');
    },
    stopPainting() {
      this.log.push('stop');
    },
    invalidate() {
      this.log.push('invalidate');
    },
  };
}

test('a page is throttled and stops painting when no panel displays it, and restores on show', () => {
  const displayed = new Set();
  const power = createBrowserPagePower({ isDisplayed: (g) => displayed.has(g) });
  const page = guest(1);
  displayed.add(page);
  power.track(page);
  assert.deepEqual(page.log, ['throttle:false', 'start', 'invalidate']);
  displayed.delete(page);
  power.refresh(page);
  assert.deepEqual(page.log.slice(3), ['throttle:true', 'stop']);
  power.refresh(page);
  assert.equal(page.log.length, 5, 'refresh is idempotent');
  displayed.add(page);
  power.refresh(page);
  assert.deepEqual(page.log.slice(5), ['throttle:false', 'start', 'invalidate']);
});

test('an agent command unthrottles a hidden page for its duration only', () => {
  const power = createBrowserPagePower({ isDisplayed: () => false });
  const page = guest(1);
  power.track(page);
  assert.deepEqual(page.log, ['throttle:true', 'stop']);
  const first = power.drive(page);
  const second = power.drive(page);
  assert.equal(power.isActive(page), true);
  assert.deepEqual(page.log.slice(2), ['throttle:false', 'start', 'invalidate']);
  first();
  first();
  assert.equal(power.isActive(page), true, 'a second command still drives the page');
  second();
  assert.equal(power.isActive(page), false);
  assert.deepEqual(page.log.slice(5), ['throttle:true', 'stop']);
});

test('idle user sessions unload; displayed, driven, busy and kept-alive ones do not', () => {
  const sessions = new BrowserSessionRegistry();
  const displayed = new Set();
  const power = createBrowserPagePower({ isDisplayed: (g) => displayed.has(g) });
  const origin = Date.now();
  const make = (sessionId, id) => {
    const page = guest(id);
    sessions.registerVisibleGuest(page);
    sessions.bindVisibleGuest(sessionId, id, true);
    power.track(page);
    return page;
  };
  make('idle', 1);
  const shown = make('shown', 2);
  const driven = make('driven', 3);
  make('kept', 4);
  make('busy', 5);
  displayed.add(shown);
  power.drive(driven);
  sessions.setBackgroundPage('kept', 'tab', {
    window: {},
    guest: guest(6),
    lastUsedAt: origin,
    kind: 'user',
    keepAlive: true,
  });
  sessions.setBackgroundPage('busy', 'work', { window: {}, guest: guest(7), lastUsedAt: origin, kind: 'agent' });
  const unloaded = [];
  const run = (now) =>
    reclaimIdleUserSessions({
      sessions,
      power,
      isBackgroundBusy: (sessionId, name) => sessionId === 'busy' && name === 'work',
      unload: (sessionId) => unloaded.push(sessionId),
      now,
    });
  run(origin + USER_PAGE_IDLE_MS - 1_000);
  assert.deepEqual(unloaded, [], 'not idle long enough');
  run(origin + USER_PAGE_IDLE_MS + 60_000);
  assert.deepEqual(unloaded, ['idle']);
});

test('a session holding an agent page waits for the agent idle threshold', () => {
  const sessions = new BrowserSessionRegistry();
  const power = createBrowserPagePower({ isDisplayed: () => false });
  const origin = Date.now();
  const page = guest(1);
  sessions.registerVisibleGuest(page);
  sessions.bindVisibleGuest('mixed', 1, true);
  power.track(page);
  const agentPage = guest(2);
  power.track(agentPage);
  sessions.setBackgroundPage('mixed', 'research', { window: {}, guest: agentPage, lastUsedAt: origin, kind: 'agent' });
  const unloaded = [];
  const run = (now) =>
    reclaimIdleUserSessions({
      sessions,
      power,
      isBackgroundBusy: () => false,
      unload: (sessionId) => unloaded.push(sessionId),
      now,
    });
  run(origin + USER_PAGE_IDLE_MS + 60_000);
  assert.deepEqual(unloaded, [], 'the agent page is still within its idle window');
  run(origin + BACKGROUND_PAGE_IDLE_MS + 60_000);
  assert.deepEqual(unloaded, ['mixed']);
});
