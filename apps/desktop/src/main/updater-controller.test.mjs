import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUpdaterController, startUnattendedInstall } from './updater-controller.ts';
import { normalizeUpdaterDevFeed } from './updater-feed.ts';

function setup({ currentVersion = '1.0.0', enabled = true, ready: initialReady, latestVersion = '2.0.0', busy } = {}) {
  const calls = [];
  const scheduledInstalls = [];
  let ready = initialReady;
  let offeredVersion = latestVersion;
  const service = {
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
      service,
      persistence: {
        get: () => ready,
        set: (value) => {
          ready = value;
        },
        clear: () => {
          ready = undefined;
        },
      },
      stop: async () => {
        calls.push('stop');
      },
      busy,
      scheduleInstall: (install) => {
        calls.push('schedule-install');
        scheduledInstalls.push(install);
      },
    }),
    getReady: () => ready,
    setLatestVersion: (version) => {
      offeredVersion = version;
    },
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

async function installWith(busy, options) {
  const updater = setup({ busy });
  await updater.controller.start();
  await updater.controller.install(options);
  if (updater.calls.includes('schedule-install')) updater.launchScheduledInstall();
  return updater;
}

test('install while agent tasks run stops nothing and asks for confirmation', async () => {
  const updater = await installWith(async () => 3);
  assert.equal(updater.calls.includes('stop'), false);
  assert.equal(updater.calls.includes('install'), false);
  assert.deepEqual(updater.controller.getState(), { status: 'ready', version: '2.0.0', busyTasks: 3 });
});

test('install with unknown agent status needs confirmation like busy', async () => {
  for (const busy of [async () => null, async () => Promise.reject(new Error('daemon unreachable'))]) {
    const updater = await installWith(busy);
    assert.equal(updater.calls.includes('install'), false);
    assert.deepEqual(updater.controller.getState(), { status: 'ready', version: '2.0.0', busyTasks: null });
  }
});

test('confirmed install proceeds while agent tasks run', async () => {
  const updater = await installWith(async () => 3, { confirmed: true });
  assert.deepEqual(updater.calls.slice(-3), ['stop', 'schedule-install', 'install']);
});

test('idle install behaves as before', async () => {
  const updater = await installWith(async () => 0);
  assert.deepEqual(updater.calls, ['check', 'download', 'stop', 'schedule-install', 'install']);
  assert.deepEqual(updater.controller.getState(), { status: 'installing', version: '2.0.0' });
});

test('the busy check is the last step before teardown: busy at commit never calls stop', async () => {
  let disposed = false;
  let checks = 0;
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: '1.0.0',
    service: {
      checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } }),
      downloadUpdate: async () => {},
      quitAndInstall() {},
    },
    persistence: { get: () => undefined, set() {}, clear() {} },
    busy: async () => {
      checks += 1;
      return 1;
    },
    stop: async () => {
      disposed = true;
    },
  });
  await controller.start();
  await controller.install();
  assert.equal(disposed, false);
  assert.equal(checks, 1);
  assert.deepEqual(controller.getState(), { status: 'ready', version: '2.0.0', busyTasks: 1 });
});

async function withBarrier(closeAnswer, { stopFails = false } = {}) {
  const calls = [];
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: '1.0.0',
    service: {
      checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } }),
      downloadUpdate: async () => {},
      quitAndInstall: () => calls.push('install'),
    },
    persistence: { get: () => undefined, set() {}, clear() {} },
    busy: async () => 0,
    barrier: {
      close: async () => {
        calls.push('barrier-close');
        return closeAnswer;
      },
      release: async () => {
        calls.push('barrier-release');
      },
    },
    stop: async () => {
      calls.push('stop');
      if (stopFails) throw new Error('teardown failed');
    },
    scheduleInstall: (install) => install(),
  });
  await controller.start();
  return { calls, controller };
}

test('barrier busy: nothing is disposed and the hold shows the count', async () => {
  const { calls, controller } = await withBarrier(2);
  await controller.install();
  assert.deepEqual(calls, ['barrier-close']);
  assert.deepEqual(controller.getState(), { status: 'ready', version: '2.0.0', busyTasks: 2 });
});

test('barrier unknown: admission is reopened and nothing is disposed', async () => {
  const { calls, controller } = await withBarrier(null);
  await controller.install();
  assert.deepEqual(calls, ['barrier-close', 'barrier-release']);
  assert.deepEqual(controller.getState(), { status: 'ready', version: '2.0.0', busyTasks: null });
});

test('barrier idle: admission closes before teardown and the install proceeds', async () => {
  const { calls, controller } = await withBarrier(0);
  await controller.install();
  assert.deepEqual(calls, ['barrier-close', 'stop', 'install']);
});

test('an abandoned install releases the barrier so the daemon takes work again', async () => {
  const { calls, controller } = await withBarrier(0, { stopFails: true });
  await assert.rejects(controller.install(), /teardown failed/);
  assert.deepEqual(calls, ['barrier-close', 'stop', 'barrier-release']);
  assert.deepEqual(controller.getState(), { status: 'ready', version: '2.0.0' });
});

test('a confirmed install does not need the barrier', async () => {
  const { calls, controller } = await withBarrier(5);
  await controller.install({ confirmed: true });
  assert.deepEqual(calls, ['stop', 'install']);
});

test('unattended install: an unknown hold does not re-enter, a fresh idle view installs once', async () => {
  let view = null;
  const calls = [];
  const logs = [];
  const retries = [];
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: '1.0.0',
    service: {
      checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } }),
      downloadUpdate: async () => {},
      quitAndInstall: () => calls.push('install'),
    },
    persistence: { get: () => undefined, set() {}, clear() {} },
    busy: async () => view,
    stop: async () => {
      calls.push('stop');
    },
    scheduleInstall: (install) => install(),
  });
  startUnattendedInstall(controller, { log: (message) => logs.push(message), schedule: (retry) => {
      retries.push(retry);
      return () => {};
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  await controller.start();
  await settle();
  assert.deepEqual(calls, []);
  assert.deepEqual(controller.getState(), { status: 'ready', version: '2.0.0', busyTasks: null });
  assert.deepEqual(logs, []);
  assert.equal(retries.length, 1);

  retries.shift()();
  await settle();
  assert.deepEqual(calls, [], 'still unknown: held again, no install');
  assert.equal(retries.length, 1);

  view = 0;
  retries.shift()();
  await settle();
  assert.deepEqual(calls, ['stop', 'install']);
  assert.deepEqual(logs, []);
  assert.equal(retries.length, 0);
});

function unattendedSetup({ view = 0, launchFails = false, stopFails = false } = {}) {
  const calls = [];
  const logs = [];
  const retries = [];
  const cancels = [];
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: '1.0.0',
    service: {
      checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } }),
      downloadUpdate: async () => {},
      quitAndInstall: () => {
        calls.push('install');
        if (launchFails) throw new Error('launch failed');
      },
    },
    persistence: { get: () => undefined, set() {}, clear() {} },
    busy: async () => view,
    stop: async () => {
      calls.push('stop');
      if (stopFails) throw new Error('teardown failed');
    },
    // As in the app: the launch runs on a later turn, after install() has returned.
    scheduleInstall: (install) => setImmediate(install),
  });
  const stopUnattended = startUnattendedInstall(controller, {
    log: (message) => logs.push(message),
    schedule: (retry) => {
      retries.push(retry);
      return () => cancels.push('cancelled');
    },
  });
  return { calls, logs, retries, cancels, controller, stopUnattended };
}
const settleAll = () => new Promise((resolve) => setTimeout(resolve, 0));

test('unattended install: a launch failure is not reinstalled in a loop', async () => {
  const { calls, controller, logs, retries } = unattendedSetup({ launchFails: true });
  await controller.start();
  await settleAll();
  await settleAll();
  assert.deepEqual(calls, ['stop', 'install'], 'one attempt, no second install');
  assert.deepEqual(controller.getState(), { status: 'ready', version: '2.0.0' });
  assert.equal(retries.length, 0);
  assert.deepEqual(logs, []);
});

test('unattended install: a teardown failure is reported once and not retried', async () => {
  const { calls, controller, logs, retries } = unattendedSetup({ stopFails: true });
  await controller.start();
  await settleAll();
  await settleAll();
  assert.deepEqual(calls, ['stop']);
  assert.deepEqual(logs, ['updater unattended install failed']);
  assert.equal(retries.length, 0);
});

test('unattended install: stopping it cancels a pending retry and nothing installs afterwards', async () => {
  const { calls, controller, retries, cancels, stopUnattended } = unattendedSetup({ view: null });
  await controller.start();
  await settleAll();
  assert.equal(retries.length, 1);

  stopUnattended();
  assert.deepEqual(cancels, ['cancelled']);
  retries.shift()();
  await settleAll();
  assert.deepEqual(calls, []);
});

test('a passed check installs without a second veto after teardown', async () => {
  const answers = [0, 2];
  const updater = await installWith(async () => answers.shift());
  assert.deepEqual(updater.calls.slice(-3), ['stop', 'schedule-install', 'install']);
  assert.deepEqual(updater.controller.getState(), { status: 'installing', version: '2.0.0' });
});

test('updater returns to ready when application shutdown cannot complete', async () => {
  const calls = [];
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: '1.0.0',
    service: {
      checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } }),
      downloadUpdate: async () => {},
      quitAndInstall: () => {
        calls.push('install');
      },
    },
    persistence: { get: () => undefined, set() {}, clear() {} },
    stop: async () => {
      throw new Error('shutdown failed');
    },
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
    service: {
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

test('packaged updater dev feeds are limited to credential-free loopback HTTP', () => {
  assert.equal(normalizeUpdaterDevFeed('http://127.0.0.1:9123/feed'), 'http://127.0.0.1:9123/feed');
  assert.equal(normalizeUpdaterDevFeed('https://updates.example.test/feed'), null);
  assert.equal(normalizeUpdaterDevFeed('http://127.0.0.1.example.test/feed'), null);
  assert.equal(normalizeUpdaterDevFeed('http://token@127.0.0.1:9123/feed'), null);
});



