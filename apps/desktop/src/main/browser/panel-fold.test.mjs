import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createBrowserPageOwner } from './page-owner.ts';
import { createBrowserPageSurface } from './page-surface.ts';
import { createBrowserPanelFold } from './panel-fold.ts';
import { BrowserSessionRegistry } from './session-registry.ts';

let nextId = 1;

function fakePage(url = 'about:blank') {
  const guest = new EventEmitter();
  guest.id = nextId++;
  guest.destroyed = false;
  guest.loads = [];
  guest.isDestroyed = () => guest.destroyed;
  guest.getURL = () => url;
  guest.loadURL = async (next) => {
    guest.loads.push(next);
  };
  guest.isLoadingMainFrame = () => false;
  guest.navigationHistory = { length: () => 1 };
  const window = new EventEmitter();
  window.closed = false;
  window.isDestroyed = () => window.closed;
  // The page's own window.close, a crash teardown or a destroy all end here.
  window.destroy = () => {
    if (window.closed) return;
    window.closed = true;
    guest.destroyed = true;
    window.emit('closed');
    guest.emit('destroyed');
  };
  return { window, guest };
}

/** The real registry, page owner (the pane's blank start page) and fold. */
function fixture(holdMs = 30) {
  const sessions = new BrowserSessionRegistry();
  const hides = [];
  const fold = createBrowserPanelFold({ sessions, hide: (sessionId) => hides.push(sessionId), holdMs });
  let created = 0;
  const owner = createBrowserPageOwner({
    sessions,
    create: () => {
      created += 1;
      return fakePage();
    },
    initialize() {},
  });
  // A panel's frame read (guest-lifecycle ensureGuest for a pane).
  const paneRead = (sessionId) => fold.panePage(sessionId, () => owner.ensure(sessionId));
  /** A background page as guest-lifecycle tracks it: its window's `closed`
   *  leaves the session (trackBackgroundPage). */
  const background = (sessionId, name, url) => {
    const page = fakePage(url);
    const entry = { ...page, lastUsedAt: 0, kind: 'agent' };
    sessions.setBackgroundPage(sessionId, name, entry);
    page.window.once('closed', () => sessions.deleteBackgroundPage(sessionId, name, entry));
    return page;
  };
  return { sessions, hides, fold, owner, paneRead, background, created: () => created };
}

test("a shown page that closes itself, the session's last, folds the panel", () => {
  const f = fixture();
  const at = f.background('s', 'at', 'https://alternativeto.net/manage-item/');
  f.sessions.selectGuest('s', at.guest);
  at.window.destroy();
  assert.deepEqual(f.hides, ['s']);

  // The same for the panel's own page closing itself, and only for the last page.
  const g = fixture();
  return g.paneRead('t').then((first) => {
    const helper = g.background('t', 'helper', 'https://example.test/helper');
    helper.window.destroy();
    assert.deepEqual(g.hides, [], 'the panel still has its page');
    first.emit('destroyed');
    assert.deepEqual(g.hides, ['t']);
  });
});

test('no blank page is made for a panel whose last page just closed; a panel opened later gets one', async () => {
  const f = fixture();
  const at = f.background('s', 'at', 'https://alternativeto.net/manage-item/');
  f.sessions.selectGuest('s', at.guest);
  at.window.destroy();

  // Reads the folding panel still sends make no page of their own.
  await assert.rejects(Promise.all([f.paneRead('s'), f.paneRead('s')]), /its panel is closing/);
  assert.equal(f.created(), 0);
  assert.deepEqual(f.sessions.visibleGuests('s'), []);

  // Opened again afterwards: the blank start page, as for any page-less session.
  const blank = await f.paneRead('s');
  assert.equal(f.created(), 1);
  assert.equal(blank.getURL(), 'about:blank');

  // A session that never had a page gets it at once.
  const fresh = fixture();
  await fresh.paneRead('new');
  assert.equal(fresh.created(), 1);
  assert.deepEqual(fresh.hides, []);
});

/** The session's last page, shown by an open panel, closes itself. */
function lose(f, sessionId = 's') {
  const at = f.background(sessionId, 'at', 'https://alternativeto.net/manage-item/');
  f.sessions.selectGuest(sessionId, at.guest);
  at.window.destroy();
}

/** A shell window's webContents, as the IPC event's sender. */
function shell(id) {
  const sender = new EventEmitter();
  sender.id = id;
  return sender;
}

test('a stale frame read creates nothing until the shell confirms the panel closed, not only the timer', async () => {
  const f = fixture(60_000);
  const a = shell(1);
  f.fold.panelShown('s', true, a, '1');
  f.fold.panelShown('s', true, a, '2');
  lose(f);
  const stale = f.paneRead('s');
  // One of two panes showing the session closing is not the fold done.
  f.fold.panelShown('s', false, a, '1');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.created(), 0);
  f.fold.panelShown('s', false, a, '2');
  await assert.rejects(stale, /its panel is closing/);
  assert.equal(f.created(), 0, 'no page for the panel that closed');
  assert.deepEqual(f.sessions.visibleGuests('s'), []);
});

test('a reloaded shell leaves no phantom pane: its remounted pane closing ends the fold at once', async () => {
  const f = fixture(60_000);
  const a = shell(1);
  f.fold.panelShown('s', true, a, '1');
  // The shell reloads: its pane reports no stop. The new document's pane
  // starts its ids over.
  a.emit('did-navigate');
  f.fold.panelShown('s', true, a, '1');
  lose(f);
  const stale = f.paneRead('s');
  f.fold.panelShown('s', false, a, '1');
  await assert.rejects(stale, /its panel is closing/);
  assert.equal(f.created(), 0);

  // A crashed or closed shell takes its panes with it, also mid-fold.
  for (const event of ['render-process-gone', 'destroyed']) {
    const g = fixture(60_000);
    const b = shell(2);
    const other = shell(3);
    g.fold.panelShown('t', true, b, '1');
    g.fold.panelShown('u', true, other, '1');
    lose(g, 't');
    lose(g, 'u');
    const gone = g.paneRead('t');
    const kept = g.paneRead('u');
    b.emit(event);
    await assert.rejects(gone, /its panel is closing/);
    // Another shell's pane still shows its session: that fold holds.
    let settled = false;
    kept
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(settled, false, event);
    g.fold.panelShown('u', false, other, '1');
    await assert.rejects(kept, /its panel is closing/);
    assert.equal(g.created(), 0);
  }
});

test('the person opening the panel again at once gets the blank start page', async () => {
  const f = fixture(60_000);
  const a = shell(1);
  f.fold.panelShown('s', true, a, '1');
  lose(f);
  const stale = f.paneRead('s');
  // Reopened before the closing pane's report even arrived.
  f.fold.panelShown('s', true, a, '2');
  const blank = await f.paneRead('s');
  assert.equal(blank.getURL(), 'about:blank');
  assert.equal(f.created(), 1);
  assert.equal(await stale, blank, 'the earlier read shows the same page; no second one is made');
  assert.equal(f.created(), 1);
});

test('an address the person enters while the panel folds opens normally', async () => {
  const f = fixture(60_000);
  lose(f);
  const stale = f.paneRead('s');
  const record = { documentGeneration: 1 };
  // The pane's control path, over guest-lifecycle's ensureGuest.
  const surface = createBrowserPageSurface({
    ensureGuest: (sessionId, options) =>
      f.fold.panePage(sessionId, () => f.owner.ensure(sessionId), { user: options.user }),
    currentGuest: (sessionId) => f.sessions.currentGuest(sessionId),
    state: { pageId: () => 'p1', for: () => record, invalidateInteraction() {} },
    cdp: { waitForIdle: async () => {}, guestDebugger: async () => ({}) },
    urlPolicy: { allowPrivateNetwork: true },
    assertUrl: async () => {},
  });
  await surface.control('s', { documentId: 'p1:1', type: 'navigate', url: 'https://example.test/' });
  assert.equal(f.created(), 1);
  const page = f.sessions.visibleGuests('s')[0];
  assert.deepEqual(
    page.loads.filter((url) => url !== 'about:blank'),
    ['https://example.test/']
  );
  // The waiting frame read shows the person's page, and nothing else is made.
  assert.equal(await stale, page);
  assert.equal(f.created(), 1);
});

test('a page made while the panel folds is the one a waiting read shows', async () => {
  const f = fixture();
  f.background('s', 'at', 'https://example.test/a').window.destroy();
  const waiting = f.paneRead('s');
  const next = f.background('s', 'next', 'https://example.test/b');
  assert.equal(await waiting, next.guest);
  assert.equal(f.created(), 0);
});

test('releasing a session is no lost page: nothing folds and the next read is unhindered', async () => {
  const f = fixture();
  const page = await f.paneRead('s');
  const helper = f.background('s', 'helper', 'https://example.test/helper');
  f.fold.quietly(() => {
    f.owner.release('s');
    helper.window.destroy();
  });
  page.emit('destroyed');
  assert.deepEqual(f.hides, []);
  await f.paneRead('s');
  assert.equal(f.created(), 2);
});
