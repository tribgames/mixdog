import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDesktopIpc } from './ipc';
import { DESKTOP_IPC } from '../shared/contract';

// A core connection's settings write carries the `desktop` announcement itself (config/value/write with `announce`), so the
// window sends none after it; the Node-hosted connection has nothing else to announce and sends it. `registerDesktopIpc` is
// what decides which one a window is (`writesAnnounceThemselves: Boolean(protocol)`).
test('a window with a core connection sends no desktop announcement after a settings write, one without does', async (context) => {
  for (const [withProtocol, expected] of [[true, []], [false, [['notifySettingsChanged', ['desktop']]]]]) {
    const handlers = new Map();
    const operations = [];
    const mainFrame = {};
    const webContents = { mainFrame, isDestroyed: () => false, send() {}, on() {}, removeListener() {}, setZoomFactor() {} };
    const protocol = {
      snapshot: () => ({}),
      attach: () => () => {},
      call: async () => ({}),
      notify() {},
      viewPorts: async () => ({}),
      watchFiles: async () => ({}),
      unwatchFiles: async () => ({}),
      watchFeed: async () => ({}),
      unwatchFeed: async () => ({}),
      loginFeed: async () => ({}),
    };
    const remove = registerDesktopIpc(
      { webContents, isDestroyed: () => false, setTitleBarOverlay() {} },
      {
        subscribe: () => () => {},
        subscribeSessionStates: () => () => {},
        invokeDesktopOperation: async (name, args) => {
          operations.push([name, args]);
          return {};
        },
      },
      {
        app: { quit() {} },
        ipcMain: {
          handle: (key, handler) => handlers.set(key, handler),
          removeHandler: (key) => handlers.delete(key),
          on() {},
          removeListener() {},
        },
        dialog: {},
        shell: {},
        ...(withProtocol ? { protocol } : {}),
      }
    );
    context.after(remove);
    const event = { sender: webContents, senderFrame: mainFrame };
    for (const [channel, args] of [
      [DESKTOP_IPC.updateSetting, ['keepAwake', true]],
      [DESKTOP_IPC.setNotificationVolume, [50]],
    ]) {
      operations.length = 0;
      await handlers.get(channel)(event, ...args);
      assert.deepEqual(
        operations.filter(([name]) => name === 'notifySettingsChanged'),
        expected,
        `${channel} ${withProtocol ? 'with' : 'without'} a core connection`
      );
    }
    remove();
  }
});
