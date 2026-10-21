import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DESKTOP_IPC, PROVIDER_MODELS_EVENT } from '../shared/contract.ts';
import { createDesktopOperations } from './desktop-operations.ts';
import { registerDesktopIpc } from './ipc.ts';
import { createRemoteMethods, executeRemoteFrame } from './remote-methods.ts';
import { createRelayPushLanes } from './remote-relay-push-lanes.ts';

test('a provider-models notification reaches every window and relay client from desktop and phone', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-provider-models-'));
  const configModule = { readConfig: () => ({}), updateConfigAsync: async (update) => update({}) };
  const listeners = new Set();
  const operations = createDesktopOperations({
    userDataPath: directory,
    loadConfig: async () => configModule,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  });
  t.after(async () => {
    await operations.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const host = {
    subscribe: () => () => {},
    subscribeSessionStates: () => () => {},
    getSnapshot: () => ({}),
    invokeDesktopOperation: operations.invoke,
    subscribeDesktopEvents: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const handlers = new Map();
  const deliveries = [];
  const mainFrame = {};
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    send: (channel, value) => deliveries.push([channel, value]),
    on() {},
    removeListener() {},
  };
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  const remove = registerDesktopIpc({ webContents, isDestroyed: () => false }, host, {
    app: { quit() {} },
    ipcMain,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '', openExternal: async () => {} },
  });
  t.after(remove);
  const frames = [];
  const push = createRelayPushLanes({
    clients: new Map([['web', { lanes: new Set(['state']) }]]),
    subscribeDesktopEvents: host.subscribeDesktopEvents,
    broadcastEncrypted: (...args) => frames.push(args),
  });
  t.after(() => push.dispose());
  const methods = createRemoteMethods({ host });
  const event = { sender: webContents, senderFrame: mainFrame };
  const handler = handlers.get(DESKTOP_IPC.notifyProviderModelsChanged);

  await handler(event, 'window-a');
  assert.deepEqual(
    deliveries.filter(([channel]) => channel === DESKTOP_IPC.providerModelsChanged),
    [[DESKTOP_IPC.providerModelsChanged, { origin: 'window-a' }]]
  );
  assert.deepEqual(frames.at(-1), [{ event: PROVIDER_MODELS_EVENT, payload: { origin: 'window-a' } }, false]);

  const reply = await executeRemoteFrame(
    methods,
    JSON.stringify({ id: 1, method: 'notifyProviderModelsChanged', params: ['phone-1'] })
  );
  assert.ok(reply, 'the remote method path answers');
  assert.deepEqual(frames.at(-1), [{ event: PROVIDER_MODELS_EVENT, payload: { origin: 'phone-1' } }, false]);
  assert.equal(deliveries.filter(([channel]) => channel === DESKTOP_IPC.providerModelsChanged).length, 2);

  assert.throws(() => handler({ sender: {}, senderFrame: mainFrame }, 'x'), /rejected/);
  await assert.rejects(Promise.resolve().then(() => handler(event, 42)));
});
