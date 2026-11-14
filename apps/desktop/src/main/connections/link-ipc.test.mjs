import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../../shared/contract.ts';
import { forwardConnectionLink } from './link-ipc.ts';

test('the window IPC answers only a routed window: close it, show Connection settings', async () => {
  const { registerConnectionLinkIpc } = await import('./link-ipc.ts');
  const { WindowRouteRegistry } = await import('./window-routes.ts');
  const closed = [];
  let shown = 0;
  const routes = new WindowRouteRegistry();
  routes.register({ id: 11, once: () => {} }, 'srv-a');
  const handlers = new Map();
  const removed = [];
  const dispose = registerConnectionLinkIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => removed.push(channel) },
    routes,
    closeWindow: (sender) => closed.push(sender.id),
    showConnectionSettings: () => {
      shown += 1;
    },
  });
  assert.deepEqual([...handlers.keys()].sort(), [DESKTOP_IPC.connectionCloseWindow, DESKTOP_IPC.connectionOpenSettings].sort());
  await handlers.get(DESKTOP_IPC.connectionCloseWindow)({ sender: { id: 11 } });
  await handlers.get(DESKTOP_IPC.connectionOpenSettings)({ sender: { id: 11 } });
  assert.deepEqual(closed, [11]);
  assert.equal(shown, 1);
  await assert.rejects(handlers.get(DESKTOP_IPC.connectionCloseWindow)({ sender: { id: 99 } }), /not attached/);
  await assert.rejects(handlers.get(DESKTOP_IPC.connectionOpenSettings)({ sender: { id: 99 } }), /not attached/);
  assert.deepEqual(closed, [11]);
  dispose();
  assert.equal(removed.length, 2);
});

test('the host-lists change reaches only the window it is forwarded to, until it closes', async () => {
  const { notifyHostListsChanged } = await import('../host-lists-changed.ts');
  const sent = [];
  const stop = forwardConnectionLink({ isDestroyed: () => false, send: (...args) => sent.push(args) });
  notifyHostListsChanged();
  assert.deepEqual(sent, [[DESKTOP_IPC.hostListsChanged, null]]);
  stop();
  notifyHostListsChanged();
  assert.equal(sent.length, 1);
});

