import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DesktopSettingsStore, desktopSettingsFromConfig } from './settings-store.ts';
import { registerDesktopIpc } from './ipc.ts';
import { requiredDesktopSettingKey } from './ipc-validation.ts';
import { requiredDesktopCapabilityRequest } from './ipc-capability-request.ts';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { defaultBrowserPermissionPolicy } from '../shared/browser-permission-policy.ts';
import { registerWindowSettingsIpc } from './ipc-window-settings.ts';





test('desktop settings read the canonical agent section and desktop defaults', () => {
  assert.deepEqual(desktopSettingsFromConfig({}), {
    autoClear: true,
    autoCompact: true,
    keepAwake: true,
    runInBackground: true,
    notificationVolume: 100,
    botHandoffLimit: 3,
    sessionAutoArchiveDays: 7,
    sessionAutoDeleteDays: 90,
    usagePinned: true,
    usageRailShortLong: false,
    usageAccountsExpanded: false,
    usageRailSlotsThree: false,
    usageRailSlotsAll: false,
    computerControl: false,
    computerObserveOnly: false,
    browserControl: false,
    browserAutoSignIn: true,
    browserHidDevices: false,
    browserPermissions: defaultBrowserPermissionPolicy(),
    saveChatLogins: true,
    computerInstalled: false,
    browserInstalled: false,
  });
  assert.deepEqual(
    desktopSettingsFromConfig({
      agent: {
        autoClear: { enabled: false },
        compaction: { auto: false },
      },
      desktop: {
        keepAwake: false,
        runInBackground: false,
        turnNotifications: false,
        notificationVolume: 250,
        usagePinned: false,
      },
    }),
    {
      autoClear: false,
      autoCompact: false,
      keepAwake: false,
      runInBackground: false,
      notificationVolume: 250,
      botHandoffLimit: 3,
      sessionAutoArchiveDays: 7,
      sessionAutoDeleteDays: 90,
      usagePinned: false,
      usageRailShortLong: false,
      usageAccountsExpanded: false,
      usageRailSlotsThree: false,
      usageRailSlotsAll: false,
      computerControl: false,
      computerObserveOnly: false,
      browserControl: false,
      browserAutoSignIn: true,
      browserHidDevices: false,
      browserPermissions: defaultBrowserPermissionPolicy(),
      saveChatLogins: true,
      computerInstalled: false,
      browserInstalled: false,
    }
  );
});

test('saved-login sign-in is on by default and an explicit off is kept', () => {
  assert.equal(desktopSettingsFromConfig({}).browserAutoSignIn, true);
  assert.equal(desktopSettingsFromConfig({ desktop: { browserAutoSignIn: false } }).browserAutoSignIn, false);
  assert.equal(requiredDesktopSettingKey('browserAutoSignIn'), 'browserAutoSignIn');
});






test('a control that is already on grandfathers its install marker', () => {
  const settings = desktopSettingsFromConfig({
    desktop: { browserControl: true, computerControl: true },
  });
  assert.equal(settings.browserInstalled, true);
  assert.equal(settings.computerInstalled, true);
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

/** A port that records what the store asks of the core. */
function recordingPort(answers = {}) {
  const calls = [];
  const watchers = new Set();
  const port = {
    invoke: async (name, args) => {
      calls.push(['invoke', name, args]);
      const answer = answers[name];
      return typeof answer === 'function' ? answer(args) : answer;
    },
    call: async (method, params) => {
      calls.push(['call', method, params]);
      const answer = answers[method];
      return typeof answer === 'function' ? answer(params) : answer;
    },
    watchConfig: (listener) => {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
  };
  return { port, calls, watchers };
}

test('settings are read and written as operations of the core', async () => {
  const { port, calls } = recordingPort({ readSettings: { keepAwake: true }, updateSetting: { keepAwake: false } });
  const store = new DesktopSettingsStore(port);
  assert.deepEqual(await store.read(), { keepAwake: true });
  assert.deepEqual(await store.update('keepAwake', false), { keepAwake: false });
  await store.updateNotificationVolume(40);
  await store.updateSessionRetention('sessionAutoArchiveDays', 30);
  await store.updateBrowserPermissions(defaultBrowserPermissionPolicy());
  assert.deepEqual(
    calls.map(([, name, args]) => [name, args]),
    [
      ['readSettings', []],
      ['updateSetting', ['keepAwake', false]],
      ['updateNotificationVolume', [40]],
      ['updateSessionRetention', ['sessionAutoArchiveDays', 30]],
      ['updateBrowserPermissions', [defaultBrowserPermissionPolicy()]],
    ]
  );
});

test('an invalid volume, retention or pin list is refused before the core is asked', async () => {
  const { port, calls } = recordingPort();
  const store = new DesktopSettingsStore(port);
  await assert.rejects(store.updateNotificationVolume(401), /notification volume is invalid/);
  await assert.rejects(store.updateSessionRetention('sessionAutoArchiveDays', 3), /retention days are invalid/);
  await assert.rejects(store.updateActivityRailPins(['nowhere']), /Activity rail pins must be/);
  await assert.rejects(store.updateBrowserCookieAutoImport({ enabled: true, profileId: '' }), /needs a Chrome profile/);
  assert.deepEqual(calls, []);
});

test('automatic cookie import reads the desktop config and writes one config value', async () => {
  const { port, calls } = recordingPort({
    'config/read': { config: { desktop: { browserCookieAutoImport: { enabled: false, profileId: 'Default' } } } },
    'config/value/write': { values: [] },
  });
  const store = new DesktopSettingsStore(port);
  assert.deepEqual(await store.readBrowserCookieAutoImport(), { enabled: false, profileId: 'Default' });
  await store.updateBrowserCookieAutoImport({ enabled: false, profileId: 'Default' });
  assert.deepEqual(calls[1], [
    'call',
    'config/value/write',
    { path: 'desktop.browserCookieAutoImport', value: { enabled: false, profileId: 'Default' } },
  ]);
});

test('a setting changed by another writer reaches the watcher once, unrelated config changes do not', async () => {
  let settings = { keepAwake: true };
  const { port, watchers } = recordingPort({ readSettings: () => settings });
  const store = new DesktopSettingsStore(port);
  const seen = [];
  const stop = await store.watch((next) => seen.push(next));
  const changed = async () => {
    for (const listener of watchers) listener();
    await new Promise((resolve) => setImmediate(resolve));
  };
  await changed();
  assert.deepEqual(seen, []);
  settings = { keepAwake: false };
  await changed();
  await changed();
  assert.deepEqual(seen, [{ keepAwake: false }]);
  stop();
  assert.equal(watchers.size, 0);
});

test('the session retention policy is read from the core config, null when a stored value is invalid', async () => {
  const stored = { config: { desktop: { sessionAutoArchiveDays: 30 } } };
  const { port } = recordingPort({ 'config/read': () => stored });
  const store = new DesktopSettingsStore(port);
  assert.deepEqual(await store.readSessionRetention(), { sessionAutoArchiveDays: 30, sessionAutoDeleteDays: 90 });
  stored.config.desktop.sessionAutoDeleteDays = 5;
  assert.equal(await store.readSessionRetention(), null);
});

test('activity rail pins are read and saved through the core', async () => {
  const { port, calls } = recordingPort({
    readActivityRailPins: { pins: ['sessions'], revision: 2 },
    updateActivityRailPins: { pins: ['sessions'], revision: 3 },
  });
  const store = new DesktopSettingsStore(port);
  assert.deepEqual(await store.readActivityRailPins(), { pins: ['sessions'], revision: 2 });
  assert.deepEqual(await store.updateActivityRailPins(['sessions'], true), { pins: ['sessions'], revision: 3 });
  assert.deepEqual(calls[1].slice(1), ['updateActivityRailPins', [['sessions'], true]]);
});