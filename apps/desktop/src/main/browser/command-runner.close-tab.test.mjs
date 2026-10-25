import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCommandRunner } from './command-runner.ts';
import { createBrowserPanelFold } from './panel-fold.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { createBrowserTabs } from './tabs.ts';

const page = (id, url) => ({
  id,
  destroyed: false,
  isDestroyed() {
    return this.destroyed;
  },
  getURL: () => url,
  getTitle: () => '',
  isLoadingMainFrame: () => false,
});

/** A runner over a real session registry, tab surface and panel fold;
 *  `surfaces` records the panel hides (guest-lifecycle requestBrowserSurface). */
function fixture() {
  const sessions = new BrowserSessionRegistry();
  const surfaces = [];
  createBrowserPanelFold({ sessions, hide: (sessionId) => surfaces.push([sessionId, 'hide']), holdMs: 10 });
  const backgroundPage = (sessionId, name, guest) => {
    const window = {
      closed: false,
      isDestroyed() {
        return this.closed;
      },
      destroy() {
        this.closed = true;
        guest.destroyed = true;
      },
    };
    const entry = { window, guest, lastUsedAt: 0, kind: 'agent' };
    sessions.setBackgroundPage(sessionId, name, entry);
    return entry;
  };
  const tabs = createBrowserTabs({
    visibleGuests: (sessionId) => sessions.visibleGuests(sessionId),
    backgroundPages: (sessionId) => sessions.backgroundPages(sessionId),
    backgroundEntryByPageId: () => null,
    ensureOffscreen: () => assert.fail('close_tab makes no page'),
    destroyBackgroundPage: (sessionId, name, entry) => {
      entry.window.destroy();
      sessions.deleteBackgroundPage(sessionId, name, entry);
    },
    pageId: (guest) => `p${guest.id}`,
    currentGuest: (sessionId) => sessions.currentGuest(sessionId),
    selectGuest: (sessionId, guest) => sessions.selectGuest(sessionId, guest),
    closeGuest: () => assert.fail('close_tab closes no visible page'),
  });
  const run = createBrowserCommandRunner({
    state: {},
    approvals: { approve: async () => {} },
    browserSessions: sessions,
    lifecycle: { restoreSession: async () => {} },
    tabs,
    downloads: {},
    taskLifecycle: {},
    retainGuest() {},
    drivePage: () => () => {},
    assertNoTakeover() {},
    services: {},
  });
  return { sessions, surfaces, backgroundPage, run };
}

test('closing the page an earlier open showed, the last one, folds the panel instead of leaving it on a blank page', async () => {
  const f = fixture();
  // navigate background:true tab "at", then `open` (its reveal selects the page).
  const at = page(21, 'https://alternativeto.net/manage-item/');
  f.backgroundPage('s', 'at', at);
  f.sessions.selectGuest('s', at);

  const reply = await f.run({ action: 'close_tab', tab: 'at', session_id: 's' });
  assert.equal(reply.text, 'Closed background tab "at".');
  assert.equal(f.sessions.paneGuest('s'), null, 'no page is left for the panel to show');
  assert.deepEqual(f.surfaces, [['s', 'hide']]);
});

test('a close that leaves the session a page keeps the panel as it is', async () => {
  const f = fixture();
  const shown = page(1, 'https://example.test/report');
  f.sessions.registerVisibleGuest(shown);
  f.sessions.bindVisibleGuest('s', 1, true);
  f.backgroundPage('s', 'scratch', page(2, 'https://example.test/helper'));
  await f.run({ action: 'close_tab', tab: 'scratch', session_id: 's' });

  // The shown background page closes, but another of the session's pages stays.
  const other = fixture();
  const result = page(3, 'https://example.test/result');
  other.backgroundPage('s', 'result', result);
  other.backgroundPage('s', 'helper', page(4, 'https://example.test/helper'));
  other.sessions.selectGuest('s', result);
  await other.run({ action: 'close_tab', tab: 'result', session_id: 's' });

  assert.deepEqual([...f.surfaces, ...other.surfaces], []);
});
