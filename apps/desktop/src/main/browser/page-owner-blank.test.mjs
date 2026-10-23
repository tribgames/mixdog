import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserCommandRunner } from './command-runner.ts';
import { createBrowserPageOwner } from './page-owner.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { createBrowserSessionTabStrip } from './session-tab-strip.ts';
import { createBrowserTabs } from './tabs.ts';

test('a released page is gone at once, though Electron destroys its page a tick after its window', async () => {
  const sessions = new BrowserSessionRegistry();
  let nextId = 0;
  const later = [];
  const create = () => {
    const handlers = {};
    const guest = {
      id: ++nextId,
      destroyed: false,
      isDestroyed: () => guest.destroyed,
      getURL: () => 'about:blank',
      invalidate() {},
      on() {},
      once: (event, handler) => {
        handlers[event] = handler;
      },
      loadURL: async () => {},
    };
    let closed = false;
    const window = {
      isDestroyed: () => closed,
      destroy() {
        closed = true;
        later.push(() => {
          guest.destroyed = true;
          handlers.destroyed?.();
        });
      },
    };
    return { guest, window };
  };
  const owner = createBrowserPageOwner({ sessions, create, initialize() {} });
  const first = await owner.ensure('s');
  owner.release('s');
  assert.equal(sessions.liveGuest('s'), null, 'no caller is handed the dying page');
  const next = await owner.ensure('s');
  assert.notEqual(next, first, 'the next demand gets a fresh page');
  for (const run of later) run();
  assert.equal(sessions.liveGuest('s'), next, "the old page's late destruction leaves the new one");
});

function fixture() {
  const sessions = new BrowserSessionRegistry();
  let nextId = 0;
  const makeGuest = () => {
    const handlers = {};
    const guest = {
      id: ++nextId,
      url: 'about:blank',
      destroyed: false,
      loading: false,
      history: 1,
      isDestroyed: () => guest.destroyed,
      getURL: () => guest.url,
      getTitle: () => guest.url,
      isLoadingMainFrame: () => guest.loading,
      navigationHistory: { length: () => guest.history },
      invalidate() {},
      on: (event, handler) => {
        handlers[event] = handler;
      },
      once: (event, handler) => {
        handlers[event] = handler;
      },
      loadURL: async () => {},
      navigate(url) {
        guest.url = url;
        guest.history += 1;
        handlers['did-navigate']?.();
      },
    };
    const window = {
      isDestroyed: () => guest.destroyed,
      destroy() {
        guest.destroyed = true;
        handlers.destroyed?.();
      },
    };
    return { guest, window };
  };
  const gate = { busy: false };
  const owner = createBrowserPageOwner({ sessions, create: makeGuest, initialize() {}, busy: () => gate.busy });
  const popup = (name = 'popup-1') => {
    const page = makeGuest();
    const entry = { guest: page.guest, window: page.window, kind: 'popup', lastUsedAt: 0 };
    sessions.setBackgroundPage('s', name, entry);
    return page.guest;
  };
  const tabs = createBrowserTabs({
    visibleGuests: (id) => sessions.visibleGuests(id),
    backgroundPages: (id) => sessions.backgroundPages(id),
    ensureOffscreen: (id, name) => {
      const page = makeGuest();
      const entry = { guest: page.guest, window: page.window, kind: 'agent', lastUsedAt: 0 };
      sessions.setBackgroundPage(id, name, entry);
      return entry;
    },
    pageId: (guest) => `p${guest.id}`,
    currentGuest: (id) => sessions.currentGuest(id),
    selectGuest: (id, guest) => sessions.selectGuest(id, guest),
    closeGuest() {},
  });
  const strip = createBrowserSessionTabStrip({
    tabs,
    currentGuest: (id) => sessions.currentGuest(id),
    lifecycle: { claimPage: owner.claim, replacementPage: owner.replacement },
    pageId: (guest) => `p${guest.id}`,
    retainGuest() {},
  });
  // The page the host makes on its own: the pane opening first, or an agent
  // command that needs one, are the same call.
  const agentCreates = () => owner.ensure('s');
  const runner = createBrowserCommandRunner({
    state: { peek: () => undefined, for: () => ({}), redactText: (_guest, text) => text },
    approvals: { approve: async () => {} },
    browserSessions: sessions,
    lifecycle: {
      restoreSession: async () => {},
      recoverCrashedGuest: async () => {},
      discardUntouchedBlank: owner.discardUntouchedBlank,
    },
    tabs,
    downloads: {},
    taskLifecycle: { begin() {}, use() {} },
    retainGuest() {},
    drivePage: () => () => {},
    assertNoTakeover() {},
    services: {
      cdp: { waitForIdle: async () => {} },
      reply: {
        dialogResult: () => null,
        refRecoveryFor: () => undefined,
        snapshotResult: async () => ({ text: 'ok' }),
      },
      settle: {},
    },
  });
  /** One agent command on the session's tab `helper` (an agent-kind page). */
  const runHelper = (turn, extra) =>
    runner({ action: 'snapshot', session_id: 's', turn_id: turn, tab: 'helper', ...extra });
  return { sessions, owner, popup, strip, agentCreates, gate, runHelper };
}

test('an untouched agent-created blank is closed once the agent works in a popup', async () => {
  const f = fixture();
  const blank = await f.agentCreates();
  const popup = f.popup();
  f.sessions.setAgentPage('s', popup, 1);
  assert.equal(f.owner.discardUntouchedBlank('s', popup), true);
  assert.equal(blank.destroyed, true);
  assert.deepEqual(f.sessions.visibleGuests('s'), []);
  assert.equal(f.sessions.currentGuest('s'), popup, 'the panel moved straight to the agent page');
  assert.equal(f.sessions.agentPage('s').guest, popup);
  assert.equal(f.owner.discardUntouchedBlank('s', popup), false, 'only once');
});

test('the blank is never closed for the page it is, or for a page the session does not own', async () => {
  const f = fixture();
  const blank = await f.agentCreates();
  assert.equal(f.owner.discardUntouchedBlank('s', blank), false);
  const stranger = f.popup();
  assert.equal(f.owner.discardUntouchedBlank('other', stranger), false);
  stranger.destroyed = true;
  assert.equal(f.owner.discardUntouchedBlank('s', stranger), false);
  assert.equal(blank.destroyed, false, 'the session keeps a page');
});

test('a blank the user took ("+" reuse or selecting it) is kept', async () => {
  const f = fixture();
  const blank = await f.agentCreates();
  f.strip.create('s'); // the only page, idle blank: "+" reuses it for the user
  const popup = f.popup();
  assert.equal(f.owner.discardUntouchedBlank('s', popup), false);
  assert.equal(blank.destroyed, false);

  const g = fixture();
  const second = await g.agentCreates();
  const other = g.popup();
  g.strip.select('s', `p${other.id}`);
  g.strip.select('s', `p${second.id}`); // the user opens the blank themselves
  assert.equal(g.owner.discardUntouchedBlank('s', other), false);
  assert.equal(second.destroyed, false);
});

test('pane opens first, then the agent opens a popup: the blank closes and the panel moves once', async () => {
  const f = fixture();
  const blank = await f.owner.ensure('s'); // the pane asked for its page
  assert.equal(f.sessions.currentGuest('s'), blank, 'the panel shows the blank');
  const popup = f.popup();
  f.sessions.setAgentPage('s', popup, 1);
  const moves = [];
  const { selectGuest, unregisterVisibleGuest } = f.sessions;
  f.sessions.selectGuest = (id, guest) => {
    moves.push(`select:${guest.id}`);
    return selectGuest.call(f.sessions, id, guest);
  };
  f.sessions.unregisterVisibleGuest = (guest) => {
    moves.push(`close:${guest.id}`);
    return unregisterVisibleGuest.call(f.sessions, guest);
  };
  assert.equal(f.owner.discardUntouchedBlank('s', popup), true);
  assert.deepEqual(moves, [`select:${popup.id}`, `close:${blank.id}`], 'selected before closing: no fallback hop');
  assert.equal(f.sessions.currentGuest('s'), popup);
});

test('the person starts typing in the address bar of the pane-created blank: the agent moving to a popup keeps it', async () => {
  const f = fixture();
  const blank = await f.owner.ensure('s'); // the pane opened first
  // What the pane sends on a click or key in the address bar: the user's own
  // select of the tab it is already showing.
  f.strip.select('s', `p${blank.id}`);
  const popup = f.popup();
  f.sessions.setAgentPage('s', popup, 1);
  assert.equal(f.owner.discardUntouchedBlank('s', popup), false);
  assert.equal(blank.destroyed, false);
  assert.equal(f.sessions.currentGuest('s'), blank, 'the person stays where they are working');
});

test('cleanup waits while a command, download or prompt is using the blank, then happens at the next trigger', async () => {
  const f = fixture();
  const blank = await f.owner.ensure('s');
  const popup = f.popup();
  f.sessions.setAgentPage('s', popup, 1);
  f.gate.busy = true; // e.g. an observation still running against the blank
  assert.equal(f.owner.discardUntouchedBlank('s', popup), false);
  assert.equal(blank.destroyed, false, 'its target is not pulled away');
  assert.equal(f.owner.discardUntouchedBlank('s', popup), false);
  f.gate.busy = false;
  assert.equal(f.owner.discardUntouchedBlank('s', popup), true, 'still marked, so the retry closes it');
  assert.equal(blank.destroyed, true);
});

test('a navigation that failed without committing still leaves the blank claimed', async () => {
  const f = fixture();
  const blank = await f.owner.ensure('s');
  f.owner.claim('s', blank); // the address-bar navigate control claims before the load can fail
  assert.equal(blank.url, 'about:blank', 'nothing committed');
  assert.equal(f.owner.discardUntouchedBlank('s', f.popup()), false);
  assert.equal(blank.destroyed, false);
});

test('a blank the user typed an address into, then returned to blank, is kept', async () => {
  const f = fixture();
  const blank = await f.owner.ensure('s');
  blank.navigate('https://example.test/'); // the user's navigation claims the page
  blank.navigate('about:blank');
  assert.equal(f.owner.discardUntouchedBlank('s', f.popup()), false);
  assert.equal(blank.destroyed, false);
});

test('a blank the agent navigates, or that is still loading, is kept', async () => {
  const f = fixture();
  const blank = await f.agentCreates();
  const popup = f.popup();
  blank.loading = true;
  assert.equal(f.owner.discardUntouchedBlank('s', popup), false, 'still loading: decided later');
  blank.loading = false;
  blank.navigate('https://example.test/');
  assert.equal(f.owner.discardUntouchedBlank('s', popup), false);
  blank.navigate('about:blank');
  assert.equal(f.owner.discardUntouchedBlank('s', popup), false, 'once touched, never reconsidered');
  assert.equal(blank.destroyed, false);
});

test('empty pane + a hidden background:true page: the blank goes and the helper is the one selected tab', async () => {
  const f = fixture();
  const blank = await f.owner.ensure('s');
  await f.runHelper(1, { background: true });
  const helper = f.sessions.backgroundPages('s').get('helper');
  assert.equal(helper.kind, 'agent');
  assert.equal(blank.destroyed, true);
  assert.deepEqual(f.sessions.visibleGuests('s'), []);
  assert.equal(f.sessions.currentGuest('s'), helper.guest);
});

test('a real page the person is on is kept when a hidden helper opens, and the agent page is selected once it reveals it', async () => {
  const f = fixture();
  const real = await f.owner.ensure('s');
  real.navigate('https://example.test/'); // claimed: no longer a placeholder
  await f.runHelper(1, { background: true });
  const helper = f.sessions.backgroundPages('s').get('helper').guest;
  assert.equal(real.destroyed, false);
  assert.equal(f.sessions.currentGuest('s'), real, 'a hidden helper does not take the selection');
  assert.equal(f.sessions.agentPage('s'), null, 'and is not followed');
  await f.runHelper(2, { background: false });
  assert.equal(f.sessions.currentGuest('s'), helper, 'the revealed agent page is the selected tab');
  assert.equal(f.sessions.agentPage('s').guest, helper);
  assert.equal(real.destroyed, false);
  assert.deepEqual(f.sessions.visibleGuests('s'), [real], "the person's page stays a tab");
});

test('a pane opened after the agent made its page shows that page and creates no blank', async () => {
  const f = fixture();
  const page = f.popup('helper');
  assert.equal(f.sessions.paneGuest('s'), page);
  assert.equal(f.sessions.currentGuest('s'), page, 'selected, so the pane keeps it');
  assert.deepEqual(f.sessions.visibleGuests('s'), []);
  assert.equal(f.sessions.paneGuest('empty'), null, 'a blank is made only when there is no page');
});

test('a blank with history of its own is kept even though it shows about:blank', async () => {
  const f = fixture();
  const blank = await f.agentCreates();
  blank.history = 3;
  assert.equal(f.owner.discardUntouchedBlank('s', f.popup()), false);
  assert.equal(blank.destroyed, false);
});
