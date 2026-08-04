import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUpdaterController } from './updater-controller.ts';

function setup({
  currentVersion = '1.0.0',
  enabled = true,
  ready: initialReady,
  latestVersion = '2.0.0',
} = {}) {
  const calls = [];
  const scheduledInstalls = [];
  let ready = initialReady;
  let offeredVersion = latestVersion;
  const backend = {
    async checkForUpdates() {
      calls.push('check');
      return { isUpdateAvailable: true, updateInfo: { version: offeredVersion } };
    },
    async downloadUpdate() {
      calls.push('download');
    },
    quitAndInstall() {
      calls.push('install');
    },
  };
  return {
    calls,
    controller: createUpdaterController({
      enabled,
      currentVersion,
      backend,
      persistence: {
        get: () => ready,
        set: (value) => { ready = value; },
        clear: () => { ready = undefined; },
      },
      stop: async () => { calls.push('stop'); },
      scheduleInstall: (install) => {
        calls.push('schedule-install');
        scheduledInstalls.push(install);
      },
    }),
    getReady: () => ready,
    setLatestVersion: (version) => { offeredVersion = version; },
    launchScheduledInstall: () => {
      assert.equal(scheduledInstalls.length, 1);
      scheduledInstalls.shift()();
    },
  };
}

test('updater checks, downloads, persists, and exposes the ready update', async () => {
  const updater = setup();
  const states = [];
  updater.controller.subscribe((state) => states.push(state.status));

  await updater.controller.start();

  assert.deepEqual(updater.calls, ['check', 'download']);
  assert.deepEqual(updater.getReady(), { version: '2.0.0' });
  assert.deepEqual(states, ['idle', 'checking', 'downloading', 'ready']);
  assert.deepEqual(updater.controller.getState(), { status: 'ready', version: '2.0.0' });
});

test('updater revalidates a persisted target through the updater cache on launch', async () => {
  const updater = setup({ ready: { version: '2.0.0' } });

  await updater.controller.start();

  assert.deepEqual(updater.calls, ['check', 'download']);
  assert.deepEqual(updater.controller.getState(), { status: 'ready', version: '2.0.0' });
});

test('updater supersedes a ready intermediate release with the newest feed target', async () => {
  const updater = setup({ currentVersion: '0.9.70', latestVersion: '0.9.71' });
  await updater.controller.start();
  updater.setLatestVersion('0.9.72');

  await updater.controller.check();

  assert.deepEqual(updater.calls, ['check', 'download', 'check', 'download']);
  assert.deepEqual(updater.getReady(), { version: '0.9.72' });
  assert.deepEqual(updater.controller.getState(), { status: 'ready', version: '0.9.72' });
});

test('updater rechecks a ready target without downloading the same release twice', async () => {
  const updater = setup({ currentVersion: '0.9.70', latestVersion: '0.9.72' });
  await updater.controller.start();

  await updater.controller.check();

  assert.deepEqual(updater.calls, ['check', 'download', 'check']);
  assert.deepEqual(updater.getReady(), { version: '0.9.72' });
  assert.deepEqual(updater.controller.getState(), { status: 'ready', version: '0.9.72' });
});

test('updater clears a persisted target that is already installed', async () => {
  const updater = setup({ currentVersion: '2.0.0', ready: { version: '2.0.0' } });

  await updater.controller.start();

  assert.equal(updater.getReady(), undefined);
  assert.deepEqual(updater.calls, ['check']);
});

test('updater acknowledges install before launching the downloaded update', async () => {
  const updater = setup();

  await Promise.all([updater.controller.check(), updater.controller.check(), updater.controller.check()]);
  await updater.controller.install();

  assert.deepEqual(updater.calls, ['check', 'download', 'stop', 'schedule-install']);
  assert.deepEqual(updater.controller.getState(), { status: 'installing', version: '2.0.0' });

  updater.launchScheduledInstall();
  assert.deepEqual(updater.calls, ['check', 'download', 'stop', 'schedule-install', 'install']);
  assert.deepEqual(updater.controller.getState(), { status: 'installing', version: '2.0.0' });
});

test('updater returns to ready when application shutdown cannot complete', async () => {
  const calls = [];
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: '1.0.0',
    backend: {
      checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } }),
      downloadUpdate: async () => {},
      quitAndInstall: () => { calls.push('install'); },
    },
    persistence: { get: () => undefined, set() {}, clear() {} },
    stop: async () => { throw new Error('shutdown failed'); },
  });

  await controller.start();
  await assert.rejects(controller.install(), /shutdown failed/);
  assert.deepEqual(calls, []);
  assert.deepEqual(controller.getState(), { status: 'ready', version: '2.0.0' });
});

test('disabled and unreachable update feeds are safe no-ops', async () => {
  const disabled = setup({ enabled: false });
  assert.deepEqual(await disabled.controller.start(), { status: 'disabled' });
  assert.deepEqual(disabled.calls, []);

  const unavailable = createUpdaterController({
    enabled: true,
    currentVersion: '1.0.0',
    backend: {
      checkForUpdates: async () => {
        throw new Error('publish feed unavailable');
      },
      downloadUpdate: async () => {},
      quitAndInstall() {},
    },
    persistence: { get: () => undefined, set() {}, clear() {} },
    stop: async () => {},
  });
  assert.deepEqual(await unavailable.start(), { status: 'error', message: 'publish feed unavailable' });
});
