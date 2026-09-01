import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserCommandQueue } from './browser-command-queue.ts';
import { createBrowserTabs } from './browser-tabs.ts';
import { createRemoteMethods } from './remote-methods.ts';
import {
  BrowserSessionRegistry,
  browserSessionId,
} from './browser-session-registry.ts';

function guest(id) {
  return {
    id,
    destroyed: false,
    repaints: 0,
    isDestroyed() { return this.destroyed; },
    invalidate() { this.repaints += 1; },
  };
}

test('browser session ids default only when omitted and reject unsafe owners', () => {
  assert.equal(browserSessionId(undefined), 'browser');
  assert.equal(browserSessionId(' session_1 '), 'session_1');
  assert.throws(() => browserSessionId('session:other'), /session_id is invalid/);
});

test('visible guests, active targets, and waiters are isolated by session', async () => {
  const registry = new BrowserSessionRegistry();
  const alpha = guest(1);
  const beta = guest(2);
  registry.registerVisibleGuest(alpha);
  registry.registerVisibleGuest(beta);

  let alphaWaiter = null;
  let betaWaiter = null;
  registry.waitForGuest('alpha', (value) => { alphaWaiter = value; });
  registry.waitForGuest('beta', (value) => { betaWaiter = value; });

  registry.bindVisibleGuest('alpha', alpha.id, true);
  assert.equal(alphaWaiter, alpha);
  assert.equal(betaWaiter, null);
  assert.deepEqual(registry.visibleGuests('alpha'), [alpha]);
  assert.equal(registry.liveGuest('beta'), null);

  registry.bindVisibleGuest('beta', beta.id, false);
  assert.equal(betaWaiter, beta);
  assert.equal(registry.liveGuest('beta'), beta);
  assert.equal(registry.currentGuest('alpha'), alpha);
  assert.equal(alpha.repaints, 1);

  registry.unregisterVisibleGuest(alpha);
  assert.equal(registry.liveGuest('alpha'), null);
  assert.equal(registry.liveGuest('beta'), beta);
});

test('background tab names may repeat across browser sessions', () => {
  const registry = new BrowserSessionRegistry();
  const alphaGuest = {};
  const betaGuest = {};
  const alpha = { window: { webContents: alphaGuest }, guest: alphaGuest, lastUsedAt: 1, kind: 'agent' };
  const beta = { window: { webContents: betaGuest }, guest: betaGuest, lastUsedAt: 2, kind: 'agent' };
  registry.setBackgroundPage('alpha', 'research', alpha);
  registry.setBackgroundPage('beta', 'research', beta);

  assert.equal(registry.backgroundPages('alpha').get('research'), alpha);
  assert.equal(registry.backgroundPages('beta').get('research'), beta);
  assert.equal(registry.sessionIdForGuest(alphaGuest), 'alpha');
  assert.equal(registry.sessionIdForGuest(betaGuest), 'beta');
  assert.equal(registry.backgroundCount(), 2);
  assert.deepEqual(
    registry.allBackgroundEntries().map(([sessionId, name]) => [sessionId, name]),
    [['alpha', 'research'], ['beta', 'research']],
  );
});

test('Browser Use command queues serialize per session instead of globally', () => {
  const queue = createBrowserCommandQueue({
    chains: new Map(),
    pendingReads: new Map(),
    sessionId: (command) => browserSessionId(command.session_id),
    backgroundEntryByPageId: () => null,
    run: async () => ({ text: 'ok' }),
    bounded: async (operation) => await operation,
    readOnlyActions: new Set(),
    commandTimeoutMs: 45_000,
  });

  assert.equal(
    queue.commandQueueKey({ action: 'navigate', session_id: 'alpha' }),
    'session:alpha:foreground',
  );
  assert.equal(
    queue.commandQueueKey({
      action: 'navigate',
      session_id: 'beta',
      background: true,
      tab: 'research',
    }),
    'session:beta:background:research',
  );
});

test('tab listing and named background targeting cannot cross session owners', () => {
  const visible = new Map([
    ['alpha', [{
      id: 1,
      isDestroyed: () => false,
      getTitle: () => 'Alpha page',
      getURL: () => 'https://alpha.test/',
    }]],
    ['beta', [{
      id: 2,
      isDestroyed: () => false,
      getTitle: () => 'Beta page',
      getURL: () => 'https://beta.test/',
    }]],
  ]);
  const background = (id, title) => ({
    window: {
      isDestroyed: () => false,
      webContents: {
        id,
        isDestroyed: () => false,
        getTitle: () => title,
        getURL: () => `https://${title.toLowerCase()}.test/`,
      },
    },
    lastUsedAt: 1,
    kind: 'agent',
  });
  const backgrounds = new Map([
    ['alpha', new Map([['research', background(3, 'Alpha background')]])],
    ['beta', new Map([['research', background(4, 'Beta background')]])],
  ]);
  const tabs = createBrowserTabs({
    visibleGuests: (sessionId) => visible.get(sessionId) ?? [],
    backgroundPages: (sessionId) => backgrounds.get(sessionId) ?? new Map(),
    backgroundEntryByPageId: () => null,
    ensureOffscreen: (sessionId, name) => backgrounds.get(sessionId).get(name),
    destroyBackgroundPage: () => {},
    pageId: (entry) => `p${entry.id}`,
    currentGuest: (sessionId) => visible.get(sessionId)?.[0] ?? null,
    selectGuest: () => {},
  });

  const alphaList = tabs.listTabs('alpha').text;
  assert.match(alphaList, /Alpha page/);
  assert.match(alphaList, /Alpha background/);
  assert.doesNotMatch(alphaList, /Beta/);
  assert.equal(
    tabs.resolveTargetGuest('beta', false, 'research').guest.id,
    4,
  );
});

test('remote session deletion releases Browser Use resources for the same owner', async () => {
  const releases = [];
  const methods = createRemoteMethods({
    host: {
      async deleteSession(sessionId) {
        return { deleted: sessionId };
      },
    },
    async browserRemote(method, args) {
      releases.push({ method, args });
      return null;
    },
  });

  assert.deepEqual(await methods.deleteSession(['session-alpha']), {
    deleted: 'session-alpha',
  });
  assert.deepEqual(releases, [{
    method: 'release',
    args: ['session-alpha'],
  }]);
});
