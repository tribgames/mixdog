import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { DesktopStateBridge } from './ipc-state-bridge.ts';
import { raiseDesktopNotice } from '../../../../src/runtime/shared/desktop-notice-host.mjs';

function bridge() {
  const sent = [];
  let serviceNotice = () => {};
  let destroyed = false;
  const instance = new DesktopStateBridge({
    window: {
      isDestroyed: () => destroyed,
      webContents: {
        isDestroyed: () => destroyed,
        send: (channel, value) => {
          if (channel === DESKTOP_IPC.desktopNotice) sent.push(value);
        },
      },
    },
    host: {
      subscribe: () => () => {},
      subscribeSessionStates: () => () => {},
      subscribeDesktopNotices(listener) {
        serviceNotice = listener;
        return () => {};
      },
      getSnapshot: () => ({}),
    },
    ipcMain: new EventEmitter(),
    handle: () => {},
  });
  return {
    instance,
    sent,
    serviceNotice: (notice) => serviceNotice(notice),
    destroy: () => {
      destroyed = true;
    },
  };
}

test("the service's notices and this process's own reach the window on one channel", (t) => {
  const { instance, sent, serviceNotice } = bridge();
  t.after(() => instance.dispose());
  const fromService = { key: 'provider-sign-in:openai', code: 'provider-sign-in-expired', params: { name: 'OpenAI' } };
  serviceNotice(fromService);
  raiseDesktopNotice('secret-storage', 'secret-storage-failed');
  raiseDesktopNotice('secret-storage', 'secret-storage-failed');
  assert.deepEqual(sent, [fromService, { key: 'secret-storage', code: 'secret-storage-failed', params: {} }]);
});

test("this process's notice raised while its window is gone reaches the next window", (t) => {
  const closing = bridge();
  closing.destroy();
  raiseDesktopNotice('vault-while-closed', 'secret-storage-failed');
  assert.deepEqual(closing.sent, []);
  closing.instance.dispose();
  const next = bridge();
  t.after(() => next.instance.dispose());
  assert.deepEqual(next.sent, [{ key: 'vault-while-closed', code: 'secret-storage-failed', params: {} }]);
});

test('a closed window no longer receives notices', () => {
  const { instance, sent } = bridge();
  instance.dispose();
  raiseDesktopNotice('after-dispose', 'conversation-save-failed');
  assert.deepEqual(sent, []);
});
