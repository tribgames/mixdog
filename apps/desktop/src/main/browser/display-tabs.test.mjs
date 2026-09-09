import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSessionRegistry } from './session-registry.ts';
import { createBrowserTabs } from './tabs.ts';

test('display tabs retain popup identity, enforce session ownership, and return to a surviving page on close', () => {
  const sessions = new BrowserSessionRegistry();
  let nextId = 0;
  const makeGuest = (title) => ({
    id: ++nextId, destroyed: false, formValue: 'unsaved',
    isDestroyed() { return this.destroyed; },
    invalidate() {},
    getTitle: () => title, getURL: () => `https://example.test/${title}`,
    isLoadingMainFrame: () => false,
  });
  const primary = makeGuest('primary');
  const other = makeGuest('private');
  for (const [owner, guest] of [['alpha', primary], ['beta', other]]) {
    sessions.registerVisibleGuest(guest);
    sessions.bindVisibleGuest(owner, guest.id, true);
  }
  const addBackground = (owner, name, kind) => {
    const guest = makeGuest(name);
    const page = {
      guest, kind, lastUsedAt: 0,
      window: { webContents: guest, isDestroyed: () => guest.destroyed },
    };
    sessions.setBackgroundPage(owner, name, page);
    return page;
  };
  const popup = addBackground('alpha', 'login', 'popup');
  const tabs = createBrowserTabs({
    visibleGuests: owner => sessions.visibleGuests(owner),
    backgroundPages: owner => sessions.backgroundPages(owner),
    ensureOffscreen: (owner, name) => addBackground(owner, name, 'agent'),
    pageId: guest => `p${guest.id}`,
    currentGuest: owner => sessions.currentGuest(owner),
    selectGuest: (owner, guest) => sessions.selectGuest(owner, guest),
    closeGuest(guest) {
      guest.destroyed = true;
      const owner = sessions.sessionIdForGuest(guest);
      const entry = [...sessions.backgroundPages(owner)].find(([, page]) => page.guest === guest);
      if (entry) sessions.deleteBackgroundPage(owner, entry[0], entry[1]);
      else sessions.unregisterVisibleGuest(guest);
    },
  });
  assert.deepEqual(tabs.displayTabs('alpha').map(tab => [tab.id, tab.kind, tab.active]), [
    [`p${primary.id}`, 'page', true], [`p${popup.guest.id}`, 'popup', false],
  ]);
  assert.throws(() => tabs.selectDisplayTab('beta', `p${popup.guest.id}`), /this session/);
  assert.throws(() => tabs.closeDisplayTab('alpha', `p${other.id}`), /this session/);
  assert.equal(other.destroyed, false);

  tabs.selectDisplayTab('alpha', `p${popup.guest.id}`);
  assert.equal(sessions.liveGuest('alpha'), popup.guest);
  assert.equal(popup.guest.formValue, 'unsaved');
  assert.equal(popup.keepAlive, true);
  assert.equal(tabs.displayTabs('alpha').find(tab => tab.active).id, `p${popup.guest.id}`);
  assert.equal(sessions.guestForSession('alpha', other.id), null);
  assert.equal(sessions.guestForSession('alpha', popup.guest.id), popup.guest);

  tabs.createDisplayTab('alpha');
  const created = sessions.currentGuest('alpha');
  assert.notEqual(created, popup.guest);
  assert.equal(tabs.displayTabs('alpha').find(tab => tab.active).kind, 'page');
  tabs.closeDisplayTab('alpha', `p${created.id}`);
  assert.equal(sessions.currentGuest('alpha'), primary);
  tabs.closeDisplayTab('alpha', `p${primary.id}`);
  assert.equal(sessions.currentGuest('alpha'), popup.guest);
  tabs.closeDisplayTab('alpha', `p${popup.guest.id}`);
  assert.equal(sessions.liveGuest('alpha'), null);
  assert.deepEqual(tabs.displayTabs('alpha'), []);
  assert.equal(sessions.currentGuest('beta'), other);
});
