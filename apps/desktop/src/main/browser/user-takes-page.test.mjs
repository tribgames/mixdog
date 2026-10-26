import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserPageOwner } from './page-owner.ts';
import { createBrowserRemoteControl } from './remote-control.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { createHandedOverPage, createUserTakesPage } from './user-takes-page.ts';

/** Three visible pages of session 's': the panel selects the first, the agent
 *  drove the second; tabs resolve by `v` position, as list_tabs prints them. */
function handoffFixture() {
  const sessions = new BrowserSessionRegistry();
  const guest = (id) => {
    const page = Object.assign(new EventEmitter(), {
      id,
      destroyed: false,
      isDestroyed: () => page.destroyed,
      invalidate() {},
    });
    return page;
  };
  const [selected, agentDriven, named] = [guest(1), guest(2), guest(3)];
  for (const page of [selected, agentDriven, named]) {
    sessions.registerVisibleGuest(page);
    sessions.bindVisibleGuest('s', page.id, false);
  }
  sessions.setAgentPage('s', agentDriven, 4);
  sessions.bindVisibleGuest('s', selected.id, true);
  sessions.pauseAgentFollow('s');
  const handedOver = createHandedOverPage({
    resolveTab: (sessionId, tab) => {
      const page = sessions.visibleGuests(sessionId)[Number(/^v(\d+)$/.exec(tab)?.[1]) - 1];
      if (!page) throw new Error(`no page "${tab}"`);
      return page;
    },
    agentPage: (sessionId) => sessions.agentPage(sessionId),
    liveGuest: (sessionId) => sessions.liveGuest(sessionId),
    owns: (sessionId, page) => sessions.sessionIdForGuest(page) === sessionId,
    selectGuest: (sessionId, page) => sessions.selectGuest(sessionId, page),
    setAgentPage: (sessionId, page, turn) => sessions.setAgentPage(sessionId, page, turn),
    resumeAgentFollow: (sessionId) => sessions.resumeAgentFollow(sessionId),
  });
  const close = (page) => {
    page.destroyed = true;
    sessions.unregisterVisibleGuest(page);
    page.emit('destroyed');
  };
  return { sessions, handedOver, close, selected, agentDriven, named };
}

test('a handed-over page is forgotten when its takeover ends, its page closes, its session releases or the host goes', () => {
  const { handedOver, close, agentDriven, named } = handoffFixture();
  const watching = () => agentDriven.listenerCount('destroyed') + named.listenerCount('destroyed');
  handedOver.capture('s', 't1', 'v3');
  handedOver.end('s', 't1');
  assert.equal(handedOver.tracked(), 1, 'still pending: kept');
  handedOver.end('s', '');
  assert.equal(handedOver.tracked(), 0, 'settled or expired: gone');
  assert.equal(watching(), 0, 'and no longer watched');
  handedOver.capture('s', 't2', 'v3');
  handedOver.capture('s', 't3', '');
  assert.equal(handedOver.tracked(), 1, 'a replaced takeover leaves nothing behind');
  assert.equal(watching(), 1);
  handedOver.forget('s');
  assert.equal(handedOver.tracked(), 0, 'session released');
  handedOver.capture('s', 't4', '');
  handedOver.dispose();
  assert.equal(handedOver.tracked(), 0, 'host disposed');
  assert.equal(watching(), 0);
  handedOver.capture('s', 't5', 'v3');
  close(named);
  assert.equal(handedOver.tracked(), 0, 'page closed');
  assert.equal(watching(), 0);
});

test('a handoff shows and reloads the handed-over page, not the selected tab', () => {
  const { sessions, handedOver, selected, agentDriven, named } = handoffFixture();
  assert.equal(sessions.liveGuest('s'), selected, 'the panel has another tab selected');
  // No tab named: the agent's page, which the post-login reload targets too.
  assert.equal(handedOver.capture('s', 't1', ''), agentDriven);
  assert.equal(handedOver.page('s', 't1'), agentDriven);
  assert.equal(handedOver.capture('s', 't3', 'v3'), named);
  assert.equal(handedOver.page('s', 't1'), null, 'only the current takeover has a page');
  assert.equal(handedOver.show('s', 't3'), named);
  assert.equal(sessions.liveGuest('s'), named, 'the panel shows the handed-over page');
  assert.deepEqual(sessions.agentPage('s'), { guest: named, turn: 4, paused: false }, 'following panes show it');
});

test('a named tab that cannot be resolved fails the handoff instead of handing over another page', () => {
  const { handedOver, agentDriven } = handoffFixture();
  assert.equal(handedOver.capture('s', 't1', ''), agentDriven);
  assert.throws(() => handedOver.capture('s', 't2', 'v9'), /Cannot hand over tab "v9": no page "v9"/);
  assert.equal(handedOver.tracked(), 0, 'nothing is recorded for the failed handoff');
  assert.equal(handedOver.page('s', 't2'), null);
  assert.equal(handedOver.show('s', 't2'), null);
  const resolvesNothing = createHandedOverPage({
    resolveTab: () => null,
    agentPage: () => ({ guest: agentDriven, turn: 1 }),
    liveGuest: () => null,
    owns: () => true,
    selectGuest() {},
    setAgentPage() {},
    resumeAgentFollow() {},
  });
  assert.throws(() => resolvesNothing.capture('s', 't3', 'v1'), /Cannot hand over tab "v1"/);
});

test('the post-login reload keeps the page captured at takeover start, and reloads nothing once it is gone', () => {
  const { handedOver, close, selected, named } = handoffFixture();
  assert.equal(handedOver.capture('s', 't1', 'v3'), named);
  // An earlier tab closes: "v3" names nothing now, "v2" the handed-over page.
  close(selected);
  assert.equal(handedOver.page('s', 't1'), named, 'tab moves never retarget it');
  close(named);
  assert.equal(handedOver.page('s', 't1'), null, 'gone: no agent or selected page stands in');
  assert.equal(handedOver.show('s', 't1'), null);
});

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
