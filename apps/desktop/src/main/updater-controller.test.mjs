import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUpdaterController } from './updater-controller.ts';

function setup({ currentVersion = '1.0.0', enabled = true } = {}) {
  const calls = [];
  const backend = {
    async checkForUpdates() {
      calls.push('check');
      return { isUpdateAvailable: true, updateInfo: { version: '2.0.0' } };
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
      stop: async () => { calls.push('stop'); },
    }),
  };
}

test('updater checks, downloads, and exposes the ready update', async () => {
  const updater = setup();
  const states = [];
  updater.controller.subscribe((state) => states.push(state.status));

  await updater.controller.start();

  assert.deepEqual(updater.calls, ['check', 'download']);
  assert.deepEqual(states, ['idle', 'checking', 'downloading', 'ready']);
  assert.deepEqual(updater.controller.getState(), { status: 'ready', version: '2.0.0' });
});

test('updater coalesces concurrent checks and installs only a downloaded update', async () => {
  const updater = setup();

  await Promise.all([updater.controller.check(), updater.controller.check(), updater.controller.check()]);
  await updater.controller.install();

  assert.deepEqual(updater.calls, ['check', 'download', 'stop', 'install']);
  assert.deepEqual(updater.controller.getState(), { status: 'ready', version: '2.0.0' });
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
  });
  assert.deepEqual(await unavailable.start(), { status: 'error', message: 'publish feed unavailable' });
});
