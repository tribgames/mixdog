import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAgentFollow } from '../../renderer/browser-agent-follow.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { createBrowserSessionTabStrip } from './session-tab-strip.ts';
import { createBrowserTabs } from './tabs.ts';

function fixture() {
  const sessions = new BrowserSessionRegistry();
  let nextId = 0;
  const makeGuest = (title) => ({
    id: ++nextId,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    invalidate() {},
    getTitle: () => title,
    getURL: () => `https://example.test/${title}`,
    isLoadingMainFrame: () => false,
  });
  const blank = makeGuest('blank');
  sessions.registerVisibleGuest(blank);
  sessions.bindVisibleGuest('s', blank.id, true);
  const other = makeGuest('other');
  sessions.registerVisibleGuest(other);
  sessions.bindVisibleGuest('t', other.id, true);
  const popup = makeGuest('popup');
  const popupPage = {
    guest: popup,
    kind: 'popup',
    lastUsedAt: 0,
    window: { isDestroyed: () => popup.destroyed },
  };
  sessions.setBackgroundPage('s', 'popup-1', popupPage);
  const tabs = createBrowserTabs({
    visibleGuests: (owner) => sessions.visibleGuests(owner),
    backgroundPages: (owner) => sessions.backgroundPages(owner),
    ensureOffscreen: (owner, name) => {
      const guest = makeGuest(name);
      const page = { guest, kind: 'agent', lastUsedAt: 0, window: { isDestroyed: () => guest.destroyed } };
      sessions.setBackgroundPage(owner, name, page);
      return page;
    },
    pageId: (guest) => `p${guest.id}`,
    currentGuest: (owner) => sessions.currentGuest(owner),
    selectGuest: (owner, guest) => sessions.selectGuest(owner, guest),
    closeGuest() {},
  });
  const retained = [];
  const strip = createBrowserSessionTabStrip({
    tabs,
    currentGuest: (owner) => sessions.currentGuest(owner),
    agentFollow: {
      isPaused: (owner) => sessions.agentPage(owner)?.paused === true,
      pause: (owner) => sessions.pauseAgentFollow(owner),
      resume: (owner) => sessions.resumeAgentFollow(owner),
    },
    lifecycle: { claimPage() {}, replacementPage: () => null },
    pageId: (guest) => `p${guest.id}`,
    retainGuest: (guest) => retained.push(guest),
  });
  // A pane: samples the host's frame facts the way the display poll does.
  const pane = () => {
    const follow = createBrowserAgentFollow((tabId, mode) => strip.select('s', tabId, mode));
    return {
      follow,
      sample() {
        const page = sessions.agentPage('s');
        follow.observe(page && { tabId: `p${page.guest.id}`, turn: page.turn, paused: page.paused }, strip.list('s'));
      },
    };
  };
  return { sessions, strip, pane, blank, popup, popupPage, other, retained };
}

const shown = (f) => f.sessions.currentGuest('s');

test('every window follows the agent to a popup, and does not claim it for the user', () => {
  const f = fixture();
  const [first, second] = [f.pane(), f.pane()];
  f.sessions.setAgentPage('s', f.popup, 1);
  first.sample();
  second.sample();
  assert.equal(shown(f), f.popup);
  assert.equal(f.popupPage.keepAlive, undefined, 'following must not mark the page keep-alive');
  assert.deepEqual(f.retained, []);
});

test('a pick in one window pauses the other window too, until a new turn', () => {
  const f = fixture();
  const [first, second] = [f.pane(), f.pane()];
  f.sessions.setAgentPage('s', f.popup, 1);
  first.sample();
  second.sample();

  f.strip.select('s', `p${f.blank.id}`); // the user, in the first window
  assert.equal(f.popupPage.keepAlive, undefined);
  first.sample();
  second.sample();
  assert.equal(shown(f), f.blank, 'the second window must not override the pick');

  f.sessions.setAgentPage('s', f.popup, 2);
  second.sample();
  assert.equal(shown(f), f.popup);
});

test('"+" pauses following, and "보기" in any window re-follows', () => {
  const f = fixture();
  const [first, second] = [f.pane(), f.pane()];
  f.sessions.setAgentPage('s', f.popup, 1);
  f.strip.create('s');
  first.sample();
  second.sample();
  f.strip.select('s', `p${f.blank.id}`);
  second.sample();
  assert.equal(shown(f), f.blank);

  first.follow.resume();
  assert.equal(shown(f), f.popup);
  assert.equal(f.popupPage.keepAlive, undefined);
  f.strip.select('s', `p${f.blank.id}`);
  first.sample();
  assert.equal(shown(f), f.blank, 'a later pick pauses again');
});

test("another session's agent activity does not move this session's panel", () => {
  const f = fixture();
  const panel = f.pane();
  f.sessions.setAgentPage('t', f.other, 9);
  panel.sample();
  assert.equal(shown(f), f.blank);
  assert.equal(f.sessions.agentPage('s'), null);
});

test('a user pick keeps the page alive; selecting without retain does not', () => {
  const f = fixture();
  f.strip.select('s', `p${f.popup.id}`);
  assert.equal(f.popupPage.keepAlive, true);
  f.popupPage.keepAlive = undefined;
  f.strip.select('s', `p${f.blank.id}`, 'agent');
  f.strip.select('s', `p${f.popup.id}`, 'resume');
  assert.equal(f.popupPage.keepAlive, undefined);
});
