import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserPageOwner } from './page-owner.ts';
import { createBrowserRemoteControl } from './remote-control.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { createUserTakesPage } from './user-takes-page.ts';

function pageFixture() {
  const sessions = new BrowserSessionRegistry();
  let nextId = 0;
  const create = () => {
    const handlers = {};
    const guest = {
      id: ++nextId,
      destroyed: false,
      isDestroyed: () => guest.destroyed,
      getURL: () => 'about:blank',
      isLoadingMainFrame: () => false,
      navigationHistory: { length: () => 1 },
      on: (event, handler) => (handlers[event] = handler),
      once: (event, handler) => (handlers[event] = handler),
      loadURL: async () => {},
    };
    return {
      guest,
      window: {
        isDestroyed: () => guest.destroyed,
        destroy() {
          guest.destroyed = true;
          handlers.destroyed?.();
        },
      },
    };
  };
  const owner = createBrowserPageOwner({ sessions, create, initialize() {} });
  const popup = create();
  sessions.setBackgroundPage('s', 'popup-1', {
    guest: popup.guest,
    window: popup.window,
    kind: 'popup',
    lastUsedAt: 0,
  });
  return { sessions, owner, popup: popup.guest };
}

test('taking a page retains it and claims it for its session', async () => {
  const { sessions, owner, popup } = pageFixture();
  const blank = await owner.ensure('s');
  const retained = [];
  const take = createUserTakesPage({
    sessionIdForGuest: (guest) => sessions.sessionIdForGuest(guest),
    claimPage: owner.claim,
    retain: (guest) => retained.push(guest),
  });
  take(blank);
  assert.deepEqual(retained, [blank]);
  assert.equal(owner.discardUntouchedBlank('s', popup), false);
  assert.equal(blank.destroyed, false);
});

test('a page no session owns is retained and nothing else', () => {
  const retained = [];
  const claimed = [];
  const take = createUserTakesPage({
    sessionIdForGuest: () => undefined,
    claimPage: (...args) => claimed.push(args),
    retain: (guest) => retained.push(guest),
  });
  take({ id: 9 });
  assert.equal(retained.length, 1);
  assert.deepEqual(claimed, []);
});

test("a paired client's control reaches onUserControl before anything can fail", async () => {
  const taken = [];
  const guest = { id: 1, isDestroyed: () => false, getURL: () => 'about:blank' };
  const remote = createBrowserRemoteControl({
    state: new BrowserGuestStateStore(),
    cdp: {},
    ensureGuest: async () => guest,
    currentGuest: () => guest,
    onUserControl: (page) => taken.push(page),
    assertResolvedUrlAllowed: async () => {
      throw new Error('refused');
    },
    drive: {},
    viewerChanged() {},
    publishFrame: async () => {},
  });
  await remote.remoteBrowserControl('s', { type: 'navigate', url: 'https://blocked.test/' }).catch(() => {});
  assert.deepEqual(taken, [guest], 'a navigation that is then refused still counts');
});
