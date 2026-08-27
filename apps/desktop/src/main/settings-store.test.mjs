import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  DesktopSettingsStore,
  desktopSettingsFromConfig,
  gitPreferencesFromConfig,
  settingsConfigModuleUrl,
} from './settings-store.ts';
import {
  registerDesktopIpc,
  requiredDesktopCapabilityRequest,
  requiredDesktopSettingKey,
} from './ipc.ts';
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

test('desktop settings read the canonical agent section and desktop defaults', () => {
  assert.deepEqual(desktopSettingsFromConfig({}), {
    autoClear: true,
    autoCompact: true,
    keepAwake: true,
    usagePinned: false,
    computerControl: false,
    browserControl: false,
  });
  assert.deepEqual(desktopSettingsFromConfig({
    agent: {
      autoClear: { enabled: false },
      compaction: { auto: false },
    },
    desktop: { keepAwake: false },
  }), {
    autoClear: false,
    autoCompact: false,
    keepAwake: false,
    usagePinned: false,
    computerControl: false,
    browserControl: false,
  });
});

test('git preferences migrate the legacy pattern into separate example and AI instructions', () => {
  assert.deepEqual(gitPreferencesFromConfig({
    desktop: { git: { commitPreset: 'custom', commitTemplate: 'fix(ui): align cards\nUse a short body.' } },
  }), {
    commitPreset: 'custom',
    commitTemplate: 'fix(ui): align cards\nUse a short body.',
    commitExample: 'fix(ui): align cards',
    commitInstructions: 'Use a short body.',
    autoCommitMessage: true,
  });
});

test('git preference writes preserve separate custom fields and a legacy projection', async () => {
  let value = {};
  const store = new DesktopSettingsStore({
    loadConfig: async () => ({
      readConfig: () => value,
      updateConfigAsync: async (updater) => {
        value = updater(value);
        return value;
      },
    }),
  });
  const saved = await store.updateGitPreferences({
    commitPreset: 'custom',
    commitExample: 'desktop: explain recovery',
    commitInstructions: 'Use the desktop type and mention user impact.',
  });
  assert.equal(saved.commitExample, 'desktop: explain recovery');
  assert.equal(saved.commitInstructions, 'Use the desktop type and mention user impact.');
  assert.equal(
    value.desktop.git.commitTemplate,
    'desktop: explain recovery\nUse the desktop type and mention user impact.',
  );
});

test('writes are atomic core updates that retain unrelated config and nested fields', async () => {
  let value = {
    providers: { openai: { enabled: true } },
    agent: {
      profile: { title: 'Owner' },
      autoClear: { idleMs: 60000 },
      compaction: { type: 'semantic', enabled: false },
    },
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
  await store.update('keepAwake', false);
  const result = await store.update('autoCompact', true);

  assert.deepEqual(result, {
    autoClear: false,
    autoCompact: true,
    keepAwake: false,
    usagePinned: false,
    computerControl: false,
    browserControl: false,
  });
  assert.deepEqual(value.providers, { openai: { enabled: true } });
  assert.deepEqual(value.agent, {
    profile: { title: 'Owner' },
    autoClear: { idleMs: 60000, enabled: false },
    compaction: { type: 'semantic', auto: true },
  });
  assert.equal(value.autoClear, undefined);
  assert.equal(value.compaction, undefined);
  assert.deepEqual(value.desktop, { keepAwake: false });
  assert.deepEqual(value.unrelated, { retained: true });
});

test('IPC accepts only the runtime-backed setting keys', () => {
  assert.equal(requiredDesktopSettingKey('autoClear'), 'autoClear');
  assert.equal(requiredDesktopSettingKey('autoCompact'), 'autoCompact');
  assert.equal(requiredDesktopSettingKey('keepAwake'), 'keepAwake');
  assert.throws(() => requiredDesktopSettingKey('homeAccess'), /invalid/);
  assert.throws(() => requiredDesktopSettingKey('updates'), /invalid/);
  assert.throws(() => requiredDesktopSettingKey({}), /invalid/);
});

test('desktop capability validation exposes Recap and rejects the retired Memory toggle API', () => {
  assert.deepEqual(requiredDesktopCapabilityRequest({
    capability: 'setRecapEnabled',
    args: [false],
  }), {
    capability: 'setRecapEnabled',
    args: [false],
  });
  assert.deepEqual(requiredDesktopCapabilityRequest({
    capability: 'getRecapSettings',
  }), {
    capability: 'getRecapSettings',
    args: [],
  });
  assert.throws(() => requiredDesktopCapabilityRequest({
    capability: 'setRecapEnabled',
    args: ['off'],
  }), /requires a boolean/);
  assert.throws(() => requiredDesktopCapabilityRequest({
    capability: 'setMemoryEnabled',
    args: [false],
  }), /unavailable/);
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
  const changed = [];
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
    subscribeSessionStates: () => () => {},
  }, {
    app: { quit() {} },
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      removeHandler: (channel) => handlers.delete(channel),
      on: () => {},
      removeListener: () => {},
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '', openExternal: async () => {} },
    settingsStore,
    onDesktopSettingsChanged: (settings) => changed.push(settings),
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
  // The change hook fires only after a SUCCESSFUL write, with the saved value.
  assert.deepEqual(changed, [{ autoClear: true, autoCompact: false }]);
  remove();
});
