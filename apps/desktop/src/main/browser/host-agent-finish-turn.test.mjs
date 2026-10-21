import assert from 'node:assert/strict';
import test from 'node:test';

import { finishBrowserTurn } from './host-agent.ts';
import { createBrowserPageOwner } from './page-owner.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { createBrowserTaskLifecycle } from './task-lifecycle.ts';

function fixture() {
  const sessions = new BrowserSessionRegistry();
  let nextId = 0;
  const makePage = () => {
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
  const owner = createBrowserPageOwner({ sessions, create: makePage, initialize() {}, busy: () => gate.busy });
  const closed = [];
  const taskLifecycle = createBrowserTaskLifecycle({
    close: (page) => closed.push(page),
    canClose: () => true,
  });
  const host = { taskLifecycle, sessions, lifecycle: owner };
  return { sessions, owner, host, makePage, gate };
}

test('a turn that ends while a command still uses the blank leaves it for the next turn end', async () => {
  const { sessions, owner, host, makePage, gate } = fixture();
  const blank = await owner.ensure('s');
  const popup = makePage();
  sessions.setBackgroundPage('s', 'popup-1', {
    guest: popup.guest,
    window: popup.window,
    kind: 'popup',
    lastUsedAt: 0,
  });
  sessions.setAgentPage('s', popup.guest, 1);
  gate.busy = true;
  finishBrowserTurn(host, 's', 1, { aborted: false });
  assert.equal(blank.destroyed, false);
  gate.busy = false;
  sessions.setAgentPage('s', popup.guest, 2);
  finishBrowserTurn(host, 's', 2, { aborted: false });
  assert.equal(blank.destroyed, true);
});

test('finishing a turn closes the implicit blank the agent has left, through the real turn end', async () => {
  const { sessions, owner, host, makePage } = fixture();
  const blank = await owner.ensure('s'); // the pane opened first
  const popup = makePage();
  sessions.setBackgroundPage('s', 'popup-1', {
    guest: popup.guest,
    window: popup.window,
    kind: 'popup',
    lastUsedAt: 0,
  });
  sessions.setAgentPage('s', popup.guest, 1);

  assert.equal(finishBrowserTurn(host, 's', 1, { aborted: false }), 0);
  assert.equal(blank.destroyed, true);
  assert.equal(sessions.currentGuest('s'), popup.guest);
  assert.equal(popup.guest.destroyed, false);
});

test('finishing a turn keeps the blank while the agent still works in it, or a user claimed it', async () => {
  const stay = fixture();
  const blank = await stay.owner.ensure('s');
  stay.sessions.setAgentPage('s', blank, 1);
  finishBrowserTurn(stay.host, 's', 1, { aborted: false });
  assert.equal(blank.destroyed, false);

  const claimed = fixture();
  const mine = await claimed.owner.ensure('s');
  const popup = claimed.makePage();
  claimed.sessions.setBackgroundPage('s', 'popup-1', {
    guest: popup.guest,
    window: popup.window,
    kind: 'popup',
    lastUsedAt: 0,
  });
  claimed.sessions.setAgentPage('s', popup.guest, 1);
  claimed.owner.claim('s', mine);
  finishBrowserTurn(claimed.host, 's', 1, { aborted: false });
  assert.equal(mine.destroyed, false);

  const none = fixture();
  assert.equal(finishBrowserTurn(none.host, 's', 1, { aborted: false }), 0, 'no agent page: nothing to do');
});
