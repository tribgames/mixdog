import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { DesktopSettingsStore, desktopSettingsFromConfig, settingsConfigModuleUrl } from './settings-store.ts';
import { registerDesktopIpc } from './ipc.ts';
import { requiredDesktopCapabilityRequest, requiredDesktopSettingKey } from './ipc-validation.ts';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerWindowSettingsIpc } from './ipc-window-settings.ts';

test('desktop zoom ignores legacy values and rejects changes without rewriting unrelated settings', async () => {
  const config = { desktop: { zoomFactor: 1.2, keepAwake: true } };
  let writes = 0;
  const store = new DesktopSettingsStore({
    loadConfig: async () => ({
      readConfig: () => config,
      updateConfigAsync: async () => {
        writes += 1;
        return config;
      },
    }),
  });
  assert.equal(await store.readZoom(), 1);
  assert.equal(await store.updateZoom(1), 1);
  for (const factor of [0.8, 1.2, 2, NaN]) {
    await assert.rejects(store.updateZoom(factor), /fixed at 100%/);
    assert.equal(await store.readZoom(), 1);
  }
  assert.equal(writes, 0);
  assert.deepEqual(config, { desktop: { zoomFactor: 1.2, keepAwake: true } });
});

test('desktop zoom IPC returns native scale and cannot apply a different scale', async () => {
  const handlers = new Map();
  const applied = [];
  const store = new DesktopSettingsStore();
  registerWindowSettingsIpc({
    window: {
      webContents: { setZoomFactor: (factor) => applied.push(factor), send() {} },
      setTitleBarOverlay() {},
    },
    app: {},
    host: {},
    handle: (channel, handler) => handlers.set(channel, handler),
    settingsStore: store,
  });
  assert.equal(await handlers.get(DESKTOP_IPC.getZoomFactor)({}), 1);
  await assert.rejects(handlers.get(DESKTOP_IPC.setZoomFactor)({}, 1.2), /fixed at 100%/);
  assert.equal(await handlers.get(DESKTOP_IPC.setZoomFactor)({}, 1), 1);
  assert.deepEqual(applied, [1, 1]);
});

test('settings config URL follows development and packaged runtime layouts', () => {
  // Absolute fixtures in the host's own path grammar: a Windows-only literal
  // is one relative segment on posix and resolves against the cwd instead.
  const root = (...segments) => resolve(sep, ...segments);
  assert.match(
    fileURLToPath(settingsConfigModuleUrl(false, root('resources'), root('repo', 'apps', 'desktop'))),
    /repo[\\/]src[\\/]runtime[\\/]shared[\\/]config\.mjs$/
  );
  assert.match(
    fileURLToPath(settingsConfigModuleUrl(true, root('resources'), root('ignored'))),
    /resources[\\/]runtime\.asar[\\/]node_modules[\\/]mixdog[\\/]src[\\/]runtime[\\/]shared[\\/]config\.mjs$/
  );
});

test('desktop settings read the canonical agent section and desktop defaults', () => {
  assert.deepEqual(desktopSettingsFromConfig({}), {
    autoClear: true,
    autoCompact: true,
    keepAwake: true,
    runInBackground: true,
    turnNotifications: true,
    usagePinned: true,
    computerControl: false,
    computerObserveOnly: false,
    browserControl: false,
    computerInstalled: false,
    browserInstalled: false,
  });
  assert.deepEqual(
    desktopSettingsFromConfig({
      agent: {
        autoClear: { enabled: false },
        compaction: { auto: false },
      },
      desktop: { keepAwake: false, runInBackground: false, turnNotifications: false, usagePinned: false },
    }),
    {
      autoClear: false,
      autoCompact: false,
      keepAwake: false,
      runInBackground: false,
      turnNotifications: false,
      usagePinned: false,
      computerControl: false,
      computerObserveOnly: false,
      browserControl: false,
      computerInstalled: false,
      browserInstalled: false,
    }
  );
});

test('a control that is already on grandfathers its install marker', () => {
  const settings = desktopSettingsFromConfig({
    desktop: { browserControl: true, computerControl: true },
  });
  assert.equal(settings.browserInstalled, true);
  assert.equal(settings.computerInstalled, true);
});

test('disabling grandfathered Browser and Computer controls persists their install markers', async () => {
  let value = {
    desktop: {
      browserControl: true,
      computerControl: true,
    },
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

  const browserOff = await store.update('browserControl', false);
  assert.equal(browserOff.browserControl, false);
  assert.equal(browserOff.browserInstalled, true);
  assert.equal(value.desktop.browserInstalled, true);

  const computerOff = await store.update('computerControl', false);
  assert.equal(computerOff.computerControl, false);
  assert.equal(computerOff.computerInstalled, true);
  assert.equal(value.desktop.computerInstalled, true);
});

test('writes are atomic core updates that retain unrelated config and nested fields', async () => {
  let value = {
    providers: { openai: { enabled: true } },
    agent: {
      profile: { title: 'Owner' },
      autoClear: { idleMs: 60000 },
      compaction: {
        type: 'semantic',
        enabled: false,
        semanticModel: 'legacy-summary-model',
        recallMemoryTimeoutMs: 12_000,
      },
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
  await store.update('runInBackground', false);
  const result = await store.update('autoCompact', true);

  assert.deepEqual(result, {
    autoClear: false,
    autoCompact: true,
    keepAwake: false,
    runInBackground: false,
    turnNotifications: true,
    usagePinned: true,
    computerControl: false,
    computerObserveOnly: false,
    browserControl: false,
    computerInstalled: false,
    browserInstalled: false,
  });
  assert.deepEqual(value.providers, { openai: { enabled: true } });
  assert.deepEqual(value.agent, {
    profile: { title: 'Owner' },
    autoClear: { idleMs: 60000, enabled: false },
    compaction: {
      summaryModel: 'legacy-summary-model',
      memoryTimeoutMs: 12_000,
    },
  });
  assert.equal(value.autoClear, undefined);
  assert.equal(value.compaction, undefined);
  assert.deepEqual(value.desktop, { keepAwake: false, runInBackground: false });
  assert.deepEqual(value.unrelated, { retained: true });
});

test('IPC accepts only the runtime-backed setting keys', () => {
  assert.equal(requiredDesktopSettingKey('autoClear'), 'autoClear');
  assert.equal(requiredDesktopSettingKey('autoCompact'), 'autoCompact');
  assert.equal(requiredDesktopSettingKey('keepAwake'), 'keepAwake');
  assert.equal(requiredDesktopSettingKey('runInBackground'), 'runInBackground');
  assert.equal(requiredDesktopSettingKey('computerControl'), 'computerControl');
  assert.equal(requiredDesktopSettingKey('computerObserveOnly'), 'computerObserveOnly');
  assert.equal(requiredDesktopSettingKey('browserControl'), 'browserControl');
  assert.equal(requiredDesktopSettingKey('browserInstalled'), 'browserInstalled');
  assert.equal(requiredDesktopSettingKey('computerInstalled'), 'computerInstalled');
  assert.throws(() => requiredDesktopSettingKey('homeAccess'), /invalid/);
  assert.throws(() => requiredDesktopSettingKey('updates'), /invalid/);
  assert.throws(() => requiredDesktopSettingKey({}), /invalid/);
});

test('desktop capability validation exposes Recap', () => {
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'setRecapEnabled',
      args: [false],
    }),
    {
      capability: 'setRecapEnabled',
      args: [false],
    }
  );
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'getRecapSettings',
    }),
    {
      capability: 'getRecapSettings',
      args: [],
    }
  );
  assert.throws(
    () =>
      requiredDesktopCapabilityRequest({
        capability: 'setRecapEnabled',
        args: ['off'],
      }),
    /requires a boolean/
  );
});

test('desktop capability validation accepts explicit voice enablement only', () => {
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'toggleVoice',
      args: [true],
    }),
    {
      capability: 'toggleVoice',
      args: [true],
    }
  );
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'toggleVoice',
      args: [false],
    }),
    {
      capability: 'toggleVoice',
      args: [false],
    }
  );
  assert.throws(
    () =>
      requiredDesktopCapabilityRequest({
        capability: 'toggleVoice',
        args: [],
      }),
    /invalid number of arguments/
  );
  assert.throws(
    () =>
      requiredDesktopCapabilityRequest({
        capability: 'toggleVoice',
        args: ['on'],
      }),
    /requires a boolean/
  );
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
  const notices = [];
  const settingsStore = {
    read: async () => ({ autoClear: true, autoCompact: true }),
    update: async (key, enabled) => {
      writes.push([key, enabled]);
      if (key === 'autoClear' && enabled === false) throw new Error('config write rejected');
      return { autoClear: true, autoCompact: enabled };
    },
  };
  const remove = registerDesktopIpc(
    window,
    {
      subscribe: () => () => {},
      subscribeSessionStates: () => () => {},
      invokeDesktopOperation: async (name, args) => {
        notices.push([name, args]);
      },
    },
    {
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
    }
  );
  const invoke = (event, ...args) => handlers.get(DESKTOP_IPC.updateSetting)(event, ...args);
  const validEvent = { sender: webContents, senderFrame: mainFrame };

  assert.throws(() => invoke({ sender: {}, senderFrame: mainFrame }, 'autoCompact', true), /rejected/);
  assert.throws(() => invoke(validEvent, 'homeAccess', true), /setting key is invalid/);
  assert.throws(() => invoke(validEvent, 'autoCompact', 'yes'), /enabled must be a boolean/);
  assert.deepEqual(await invoke(validEvent, 'autoCompact', false), { autoClear: true, autoCompact: false });
  await assert.rejects(invoke(validEvent, 'autoClear', false), /config write rejected/);
  assert.deepEqual(writes, [
    ['autoCompact', false],
    ['autoClear', false],
  ]);
  // The change hook fires only after a SUCCESSFUL write, with the saved value.
  assert.deepEqual(changed, [{ autoClear: true, autoCompact: false }]);
  // Paired browsers and other windows hear about the same successful write.
  assert.deepEqual(notices, [['notifySettingsChanged', ['desktop']]]);
  remove();
});

function memoryStore(initial) {
  const state = { value: initial };
  const store = new DesktopSettingsStore({
    loadConfig: async () => ({
      readConfig: () => state.value,
      updateConfigAsync: async (updater) => {
        state.value = updater(state.value);
        return state.value;
      },
    }),
  });
  return { state, store };
}

test('toggles equal to the code default are removed, not written', async () => {
  const { state, store } = memoryStore({
    desktop: { keepAwake: false, computerControl: true, computerInstalled: true, other: 1 },
  });
  await store.update('keepAwake', true);
  await store.update('usagePinned', true);
  await store.update('computerControl', false);
  await store.update('browserControl', false);
  assert.deepEqual(state.value.desktop, { computerInstalled: true, other: 1 });
  await store.update('usagePinned', false);
  await store.update('computerObserveOnly', true);
  assert.deepEqual(state.value.desktop, {
    computerInstalled: true,
    other: 1,
    usagePinned: false,
    computerObserveOnly: true,
  });
});

test('defaults separation backs up, drops default-equal and dead keys, keeps user values, and runs once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-sep-'));
  try {
    const original = {
      agent: { profile: { title: 'x' } },
      desktop: {
        keepAwake: true,
        runInBackground: false,
        usagePinned: true,
        computerControl: false,
        zoomFactor: 1.2,
        git: { commitPreset: 'none' },
        browserInstalled: true,
        activityRailPins: { pins: ['sessions', 'agents', 'schedules', 'workflows', 'projects'], revision: 3 },
      },
    };
    await writeFile(join(dir, 'mixdog-config.json'), JSON.stringify(original));
    const { state, store } = memoryStore(original);
    assert.equal(await store.separateDefaults(dir, new Date('2026-10-12T00:00:00Z')), true);
    assert.deepEqual(state.value.desktop, { runInBackground: false, browserInstalled: true, defaultsSeparationVersion: 1 });
    assert.deepEqual(state.value.agent, original.agent);
    const [backup] = await readdir(join(dir, 'backups'));
    assert.match(backup, /^defaults-separation-2026-10-12/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'backups', backup, 'mixdog-config.json'), 'utf8')), original);
    const after = JSON.stringify(state.value);
    assert.equal(await store.separateDefaults(dir), false);
    assert.equal(JSON.stringify(state.value), after);
    assert.equal((await readdir(join(dir, 'backups'))).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaults separation removes the current default pin list and keeps a customized one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-sep-'));
  try {
    const current = memoryStore({
      desktop: {
        activityRailPins: { pins: ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions'], revision: 1 },
      },
    });
    await current.store.separateDefaults(dir);
    assert.equal(current.state.value.desktop.activityRailPins, undefined);
    const custom = { pins: ['sessions', 'search'], revision: 4 };
    const kept = memoryStore({ desktop: { activityRailPins: custom } });
    await kept.store.separateDefaults(dir);
    assert.deepEqual(kept.state.value.desktop.activityRailPins, custom);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saving the default pin list stores only the revision and still reads back the default', async () => {
  const { state, store } = memoryStore({});
  const defaults = ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions'];
  assert.deepEqual(await store.updateActivityRailPins(defaults), { pins: defaults, revision: 1 });
  assert.deepEqual(state.value.desktop.activityRailPins, { revision: 1 });
  assert.deepEqual(await store.readActivityRailPins(), { pins: defaults, revision: 1 });
  assert.deepEqual(await store.updateActivityRailPins(['sessions']), { pins: ['sessions'], revision: 2 });
  assert.deepEqual(state.value.desktop.activityRailPins, { pins: ['sessions'], revision: 2 });
  assert.deepEqual(await store.updateActivityRailPins(defaults), { pins: defaults, revision: 3 });
  assert.deepEqual(state.value.desktop.activityRailPins, { revision: 3 });
});

test('defaults separation backs up the locked pre-image without overwriting and never downgrades', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-sep-'));
  try {
    const now = new Date('2026-10-12T00:00:00Z');
    const first = { desktop: { keepAwake: true, marker: 1 } };
    // The file on disk differs from the pre-image the updater receives.
    await writeFile(join(dir, 'mixdog-config.json'), JSON.stringify({ stale: true }));
    await memoryStore(first).store.separateDefaults(dir, now);
    await memoryStore({ desktop: { keepAwake: true, other: 2 } }).store.separateDefaults(dir, now);
    const names = (await readdir(join(dir, 'backups'))).sort();
    assert.equal(names.length, 2);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'backups', names[0], 'mixdog-config.json'), 'utf8')), first);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, 'backups', names[1], 'mixdog-config.json'), 'utf8')),
      { desktop: { keepAwake: true, other: 2 } }
    );
    const newer = memoryStore({ desktop: { keepAwake: false, defaultsSeparationVersion: 2 } });
    assert.equal(await newer.store.separateDefaults(dir, now), false);
    assert.deepEqual(newer.state.value.desktop, { keepAwake: false, defaultsSeparationVersion: 2 });
    assert.equal((await readdir(join(dir, 'backups'))).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
