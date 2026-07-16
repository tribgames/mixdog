import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  DesktopSettingsStore,
  desktopSettingsFromConfig,
  settingsConfigModuleUrl,
} from './settings-store.ts';
import { registerDesktopIpc, requiredDesktopSettingKey } from './ipc.ts';
import { DESKTOP_IPC } from '../shared/contract.ts';

test('settings config URL follows development and packaged runtime layouts', () => {
  assert.match(
    fileURLToPath(settingsConfigModuleUrl(false, 'C:\\resources', 'C:\\repo\\apps\\desktop')),
    /repo[\\/]src[\\/]runtime[\\/]shared[\\/]config\.mjs$/,
  );
  assert.match(
    fileURLToPath(settingsConfigModuleUrl(true, 'C:\\resources', 'C:\\ignored')),
    /resources[\\/]runtime\.asar[\\/]node_modules[\\/]mixdog[\\/]src[\\/]runtime[\\/]shared[\\/]config\.mjs$/,
  );
});

test('desktop settings use the same safe defaults and aliases as core config', () => {
  assert.deepEqual(desktopSettingsFromConfig({}), {
    autoClear: true,
    autoCompact: true,
  });
  assert.deepEqual(desktopSettingsFromConfig({
    autoClear: { enabled: false },
    compaction: { enabled: false },
  }), {
    autoClear: false,
    autoCompact: false,
  });
});

test('writes are atomic core updates that retain unrelated config and nested fields', async () => {
  let value = {
    providers: { openai: { enabled: true } },
    autoClear: { idleMs: 60000 },
    compaction: { type: 'semantic', enabled: false },
    unrelated: { retained: true },
  };
  const store = new DesktopSettingsStore({
    loadConfig: async () => ({
      readConfig: () => value,
      updateConfigAsync: async (updater) => {
        value = updater(value);
        return value;
      },
    }),
  });

  await store.update('autoClear', false);
  const result = await store.update('autoCompact', true);

  assert.deepEqual(result, { autoClear: false, autoCompact: true });
  assert.deepEqual(value.providers, { openai: { enabled: true } });
  assert.deepEqual(value.autoClear, { idleMs: 60000, enabled: false });
  assert.deepEqual(value.compaction, { type: 'semantic', auto: true });
  assert.deepEqual(value.unrelated, { retained: true });
});

test('IPC accepts only the two runtime-backed setting keys', () => {
  assert.equal(requiredDesktopSettingKey('autoClear'), 'autoClear');
  assert.equal(requiredDesktopSettingKey('autoCompact'), 'autoCompact');
  assert.throws(() => requiredDesktopSettingKey('homeAccess'), /invalid/);
  assert.throws(() => requiredDesktopSettingKey('updates'), /invalid/);
  assert.throws(() => requiredDesktopSettingKey({}), /invalid/);
});

test('updateSetting IPC enforces sender, key, boolean, success, and store rejection', async () => {
  const handlers = new Map();
  const mainFrame = {};
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    send() {},
  };
  const window = { webContents, isDestroyed: () => false };
  const writes = [];
  const settingsStore = {
    read: async () => ({ autoClear: true, autoCompact: true }),
    update: async (key, enabled) => {
      writes.push([key, enabled]);
      if (key === 'autoClear' && enabled === false) throw new Error('config write rejected');
      return { autoClear: true, autoCompact: enabled };
    },
  };
  const remove = registerDesktopIpc(window, {
    subscribe: () => () => {},
  }, {
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      removeHandler: (channel) => handlers.delete(channel),
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '' },
    settingsStore,
  });
  const invoke = (event, ...args) => handlers.get(DESKTOP_IPC.updateSetting)(event, ...args);
  const validEvent = { sender: webContents, senderFrame: mainFrame };

  assert.throws(
    () => invoke({ sender: {}, senderFrame: mainFrame }, 'autoCompact', true),
    /rejected/,
  );
  assert.throws(() => invoke(validEvent, 'homeAccess', true), /setting key is invalid/);
  assert.throws(() => invoke(validEvent, 'autoCompact', 'yes'), /enabled must be a boolean/);
  assert.deepEqual(
    await invoke(validEvent, 'autoCompact', false),
    { autoClear: true, autoCompact: false },
  );
  await assert.rejects(
    invoke(validEvent, 'autoClear', false),
    /config write rejected/,
  );
  assert.deepEqual(writes, [['autoCompact', false], ['autoClear', false]]);
  remove();
});
