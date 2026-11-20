import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserPagePower, reclaimIdleUserSessions } from './page-power.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { BACKGROUND_PAGE_IDLE_MS, IDLE_RELEASE_MS } from './tab-policy.ts';

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


function harness(options = {}) {
  const sessions = new BrowserSessionRegistry();
  const displayed = new Set();
  const power = createBrowserPagePower({ isDisplayed: (g) => displayed.has(g) });
  const origin = Date.now();
  const unloaded = [];
  const held = new Set();
  const downloading = new Set();
  const page = (sessionId, id) => {
    const g = guest(id);
    sessions.registerVisibleGuest(g);
    sessions.bindVisibleGuest(sessionId, id, true);
    power.track(g);
    return g;
  };
  const background = (sessionId, name, id, extra = {}) => {
    const g = guest(id);
    power.track(g);
    sessions.setBackgroundPage(sessionId, name, { window: {}, guest: g, lastUsedAt: origin, kind: 'agent', ...extra });
    return g;
  };
  const run = (now) =>
    reclaimIdleUserSessions({
      sessions,
      power,
      isBackgroundBusy: options.busy ?? (() => false),
      holdsPage: (g) => held.has(g),
      downloading: (sessionId) => downloading.has(sessionId),
      unload: (sessionId) => unloaded.push(sessionId),
      now,
    });
  return { sessions, power, displayed, origin, unloaded, held, downloading, page, background, run };
}

test('every page of a live turn waits 10 minutes; once the turn ended all wait 5', () => {
  const h = harness();
  h.page('live', 1);
  h.background('live', 'tab', 2, { kind: 'user' });
  h.page('over', 3);
  h.background('over', 'tab', 4, { kind: 'popup' });
  h.sessions.beginTurn('live', 1);
  h.sessions.beginTurn('over', 1);
  h.sessions.finishTurn('over', 1, h.origin - 60_000);
  h.run(h.origin + IDLE_RELEASE_MS + 1_000);
  assert.deepEqual(h.unloaded, ['over']);
  h.run(h.origin + BACKGROUND_PAGE_IDLE_MS - 1_000);
  assert.equal(h.unloaded.includes('live'), false, 'a live turn keeps its pages');
  h.run(h.origin + BACKGROUND_PAGE_IDLE_MS + 1_000);
  assert.equal(h.unloaded.includes('live'), true);
});

test('a turn that only just ended is counted from its end', () => {
  const h = harness();
  h.page('s', 1);
  h.sessions.beginTurn('s', 1);
  const finishedAt = h.origin + 10 * 60_000;
  h.sessions.finishTurn('s', 1, finishedAt);
  h.run(finishedAt + 60_000);
  assert.deepEqual(h.unloaded, []);
  h.run(finishedAt + IDLE_RELEASE_MS + 1_000);
  assert.deepEqual(h.unloaded, ['s']);
});

test('a kept page unloads with its session like any other', () => {
  const h = harness();
  h.background('s', 'kept', 1, { keepAlive: true });
  h.run(h.origin + IDLE_RELEASE_MS + 1_000);
  assert.deepEqual(h.unloaded, ['s']);
});

test('displayed, driven, busy and held sessions stay loaded; an idle one unloads', () => {
  const h = harness({ busy: (sessionId, name) => sessionId === 'busy' && name === 'work' });
  h.page('idle', 1);
  h.displayed.add(h.page('shown', 2));
  h.power.drive(h.page('driven', 3));
  h.page('busy', 5);
  h.background('busy', 'work', 7);
  h.held.add(h.page('typed', 8));
  h.page('download', 9);
  h.downloading.add('download');
  h.run(h.origin + IDLE_RELEASE_MS - 1_000);
  assert.deepEqual(h.unloaded, [], 'not idle long enough');
  h.run(h.origin + IDLE_RELEASE_MS + 60_000);
  assert.deepEqual(h.unloaded, ['idle']);
});

test('a popup that depends on its live opener keeps the session loaded', () => {
  const h = harness();
  const opener = h.page('s', 1);
  const popup = guest(2);
  h.power.track(popup);
  h.sessions.setBackgroundPage('s', 'popup-1', { window: {}, guest: popup, lastUsedAt: h.origin, kind: 'popup', opener });
  h.run(h.origin + IDLE_RELEASE_MS + 60_000);
  assert.deepEqual(h.unloaded, []);
  opener.isDestroyed = () => true;
  h.run(h.origin + IDLE_RELEASE_MS + 60_000);
  assert.deepEqual(h.unloaded, ['s']);
});

test('driven is reported apart from display', () => {
  const power = createBrowserPagePower({ isDisplayed: () => true });
  const page = guest(1);
  power.track(page);
  assert.equal(power.isDriven(page), false);
  const release = power.drive(page);
  assert.equal(power.isDriven(page), true);
  release();
  assert.equal(power.isDriven(page), false);
});
