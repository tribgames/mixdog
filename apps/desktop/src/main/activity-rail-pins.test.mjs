import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ACTIVITY_RAIL_PINS_EVENT, DESKTOP_IPC } from '../shared/contract.ts';
import { createDesktopOperations } from './desktop-operations.ts';
import { DesktopSettingsStore } from './settings-store.ts';
import { registerDesktopIpc } from './ipc.ts';
import { createRemoteMethods, executeRemoteFrame } from './remote-methods.ts';
import { createRelayPushLanes } from './remote-relay-push-lanes.ts';

test('desktop and web share ordered pins, atomic initialization, revisions and non-droppable notifications', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-rail-pins-'));
  let config = { desktop: { keepAwake: false }, other: { preserved: true } };
  let writes = Promise.resolve();
  const configModule = {
    readConfig: () => config,
    updateConfigAsync: (update) => {
      const saved = writes.then(() => {
        config = update(config);
        return config;
      });
      writes = saved.catch(() => {});
      return saved;
    },
  };
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
  const invoke = (key, ...args) => handlers.get(DESKTOP_IPC[key])(event, ...args);
  assert.equal(await invoke('readActivityRailPins'), null);
  assert.throws(
    () => handlers.get(DESKTOP_IPC.updateActivityRailPins)({ sender: {}, senderFrame: mainFrame }, []),
    /rejected/
  );

  const desktop = await invoke('updateActivityRailPins', ['projects', 'sessions', 'projects'], true);
  assert.deepEqual(desktop, { pins: ['projects', 'sessions'], revision: 1 });
  assert.deepEqual(await methods.readActivityRailPins([]), desktop);
  const web = await methods.updateActivityRailPins([['workflows', 'projects']]);
  assert.deepEqual(web, { pins: ['workflows', 'projects'], revision: 2 });
  assert.deepEqual(await invoke('readActivityRailPins'), web);
  assert.deepEqual(deliveries.at(-1), [DESKTOP_IPC.activityRailPinsChanged, web]);
  assert.deepEqual(frames.at(-1), [{ event: ACTIVITY_RAIL_PINS_EVENT, payload: web }, false]);
  assert.deepEqual(
    await invoke('updateActivityRailPins', ['sessions'], true),
    web,
    'a late desktop bootstrap cannot replace a web edit'
  );
  assert.equal(config.desktop.keepAwake, false);
  assert.deepEqual(config.other, { preserved: true });

  const before = structuredClone(config);
  const count = frames.length;
  for (const pins of [null, 'sessions', ['browser'], ['sessions', 1], { pins: [] }]) {
    await assert.rejects(invoke('updateActivityRailPins', pins), /supported destinations/);
    const reply = await executeRemoteFrame(
      methods,
      JSON.stringify({ id: 1, method: 'updateActivityRailPins', params: [pins] })
    );
    assert.equal(reply.ok, false);
  }
  await assert.rejects(invoke('updateActivityRailPins', [], 'yes'), /must be a boolean/);
  assert.deepEqual(config, before);
  assert.equal(frames.length, count, 'failed writes do not notify clients');

  const results = await Promise.all([
    invoke('updateActivityRailPins', ['search', 'sessions']),
    methods.updateActivityRailPins([[]]),
  ]);
  assert.deepEqual(results, [
    { pins: ['search', 'sessions'], revision: 3 },
    { pins: [], revision: 4 },
  ]);
  assert.deepEqual(await new DesktopSettingsStore({ loadConfig: async () => configModule }).readActivityRailPins(), {
    pins: [],
    revision: 4,
  });
});
