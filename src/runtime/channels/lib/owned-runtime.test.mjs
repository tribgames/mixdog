// Characterization of the owned-runtime lifecycle: bridge activation →
// automation arm → stop/teardown ordering, mid-start stop bail, automation-only
// start, and config hot-reload. Module-boundary collaborators are stubbed so
// the test pins the lifecycle's observable call order, not the collaborators.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const calls = [];
const record = (...entry) => calls.push(entry);
const names = () => calls.map((entry) => entry[0]);
const fixtures = {
  loadedConfig: null,
  initProviders: async () => {},
};

class FakeWebhookServer {
  constructor(cfg) {
    this.cfg = cfg;
    record('webhook.new');
  }
  start() {
    record('webhook.start');
  }
  async stop() {
    record('webhook.stop');
  }
  async reloadConfig(cfg, opts) {
    this.cfg = cfg;
    record('webhook.reload', opts?.autoStart);
  }
}
class FakeEventPipeline {
  constructor() {
    this.queue = {};
    record('pipeline.new');
  }
  getQueue() {
    return this.queue;
  }
  start() {
    record('pipeline.start');
  }
  stop() {
    record('pipeline.stop');
  }
  reloadConfig() {
    record('pipeline.reload');
  }
}

const here = (rel) => new URL(rel, import.meta.url).href;
mock.module(here('./config.mjs'), {
  namedExports: {
    loadConfig: async () => {
      record('loadConfig');
      return fixtures.loadedConfig;
    },
  },
});
mock.module(here('./webhook.mjs'), { namedExports: { WebhookServer: FakeWebhookServer } });
mock.module(here('./event-pipeline.mjs'), { namedExports: { EventPipeline: FakeEventPipeline } });
mock.module(here('./status-snapshot.mjs'), {
  namedExports: {
    startSnapshotWriter: () => record('snapshot.start'),
    stopSnapshotWriter: () => record('snapshot.stop'),
  },
});
mock.module(here('../../agent/orchestrator/providers/registry.mjs'), {
  namedExports: {
    initProviders: async (providers) => {
      record('initProviders');
      await fixtures.initProviders(providers);
    },
  },
});
mock.module(here('../../agent/orchestrator/config.mjs'), {
  namedExports: { loadConfig: () => ({ providers: {} }) },
});
mock.module(here('./runtime-paths.mjs'), {
  namedExports: {
    refreshActiveInstance: () => record('advert'),
    releaseOwnedChannelLocks: () => record('locks.release'),
    clearActiveInstance: () => record('advert.clear'),
  },
});

const { createOwnedRuntime } = await import('./owned-runtime.mjs');

function makeConfig(overrides = {}) {
  return {
    webhook: { enabled: true },
    events: { rules: [] },
    schedules: [],
    ...overrides,
  };
}

function makeHarness(t, { config = makeConfig() } = {}) {
  t.mock.method(process.stderr, 'write', () => true);
  calls.length = 0;
  const state = {
    config,
    connected: false,
    webhookServer: null,
    eventPipeline: null,
    active: true,
  };
  const runtime = createOwnedRuntime({
    getConfig: () => state.config,
    setConfig: (v) => {
      state.config = v;
    },
    getBridgeRuntimeConnected: () => state.connected,
    setBridgeRuntimeConnected: (v) => {
      state.connected = v;
    },
    getWebhookServer: () => state.webhookServer,
    setWebhookServer: (v) => {
      state.webhookServer = v;
    },
    getEventPipeline: () => state.eventPipeline,
    setEventPipeline: (v) => {
      state.eventPipeline = v;
    },
    getChannelBridgeActive: () => state.active,
    instanceId: 'inst-1',
    TERMINAL_LEAD_PID: 42,
    sendNotifyToParent: (method, params) => record('notify', method, params?.state),
    scheduler: {
      start: () => record('scheduler.start'),
      stop: () => record('scheduler.stop'),
      reloadConfig: (_schedules, opts) => record('scheduler.reload', opts?.restart),
    },
    logOwnership: (line) => record('ownership', line),
    currentOwnerState: () => ({}),
    wireWebhookHandlers: () => record('wire.webhook'),
    wireEventQueueHandlers: () => record('wire.events'),
  });
  return { state, runtime };
}

const CONNECTED_START = [
  'advert',
  'notify',
  'initProviders',
  'scheduler.start',
  'snapshot.start',
  'pipeline.new',
  'wire.events',
  'pipeline.start',
  'webhook.new',
  'wire.webhook',
  'webhook.start',
  'ownership',
];

test('startOwnedRuntime advertises, arms automation once and notifies acquired', async (t) => {
  const { state, runtime } = makeHarness(t);
  await runtime.startOwnedRuntime();
  assert.deepEqual(names(), CONNECTED_START);
  assert.deepEqual(calls[1], ['notify', 'notifications/mixdog/remote', 'acquired']);
  assert.deepEqual(calls.at(-1), ['ownership', `active owner lead=42 pid=${process.pid}`]);
  assert.equal(state.connected, true);
  assert.ok(state.webhookServer instanceof FakeWebhookServer);
  assert.ok(state.eventPipeline instanceof FakeEventPipeline);

  calls.length = 0;
  await runtime.startOwnedRuntime();
  assert.deepEqual(names(), [], 'an already-connected owner does not re-arm');
});

test('startOwnedRuntime does nothing while the bridge is inactive', async (t) => {
  const { state, runtime } = makeHarness(t);
  state.active = false;
  await runtime.startOwnedRuntime();
  assert.deepEqual(names(), []);
  assert.equal(state.connected, false);
});

test('stopOwnedRuntime tears automation down and is idempotent', async (t) => {
  const { state, runtime } = makeHarness(t);
  await runtime.startOwnedRuntime();
  calls.length = 0;
  await runtime.stopOwnedRuntime('bridge inactive');
  assert.deepEqual(names(), [
    'scheduler.stop',
    'snapshot.stop',
    'webhook.stop',
    'pipeline.stop',
    'locks.release',
    'advert.clear',
    'ownership',
  ]);
  assert.deepEqual(calls.at(-1), ['ownership', 'standby: bridge inactive']);
  assert.equal(state.connected, false);
  assert.equal(state.webhookServer, null);
  assert.equal(state.eventPipeline, null);

  calls.length = 0;
  await runtime.stopOwnedRuntime('again');
  assert.deepEqual(names(), [], 'a second stop on a torn-down runtime is a no-op');
});

test('a stop landing mid-start makes the in-flight start bail without arming automation', async (t) => {
  let releaseInit;
  fixtures.initProviders = () =>
    new Promise((resolve) => {
      releaseInit = resolve;
    });
  t.after(() => {
    fixtures.initProviders = async () => {};
  });
  const { state, runtime } = makeHarness(t);
  const start = runtime.startOwnedRuntime();
  await runtime.stopOwnedRuntime('shutdown');
  assert.deepEqual(names(), [
    'advert',
    'notify',
    'initProviders',
    'scheduler.stop',
    'snapshot.stop',
    'locks.release',
    'advert.clear',
    'ownership',
  ]);
  assert.equal(state.connected, false);

  calls.length = 0;
  releaseInit();
  await start;
  assert.deepEqual(names(), ['locks.release', 'advert.clear']);
  assert.equal(state.connected, false);
});

test('reloadRuntimeConfig re-arms the scheduler and hot-reloads automation services', async (t) => {
  const { runtime } = makeHarness(t);
  await runtime.startOwnedRuntime();
  fixtures.loadedConfig = makeConfig();
  calls.length = 0;
  await runtime.reloadRuntimeConfig();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(names(), [
    'loadConfig',
    'scheduler.reload',
    'pipeline.reload',
    'wire.events',
    'pipeline.start',
    'wire.webhook',
    'webhook.reload',
    'wire.webhook',
    'webhook.start',
  ]);
  assert.deepEqual(calls[1], ['scheduler.reload', true]);
  assert.deepEqual(calls[6], ['webhook.reload', false]);
});

test('reloadRuntimeConfig on a stopped runtime tears the webhook and event runtime down', async (t) => {
  const { runtime } = makeHarness(t);
  fixtures.loadedConfig = makeConfig();
  await runtime.reloadRuntimeConfig();
  assert.deepEqual(names(), ['loadConfig', 'scheduler.reload']);
  assert.deepEqual(calls[1], ['scheduler.reload', false]);
});

test('startAutomationRuntime is idempotent and a stop during its init aborts arming', async (t) => {
  const { runtime } = makeHarness(t);
  await runtime.startAutomationRuntime();
  assert.deepEqual(names(), [
    'initProviders',
    'scheduler.start',
    'snapshot.start',
    'pipeline.new',
    'wire.events',
    'pipeline.start',
    'webhook.new',
    'wire.webhook',
    'webhook.start',
  ]);
  calls.length = 0;
  await runtime.startAutomationRuntime();
  assert.deepEqual(names(), ['pipeline.start', 'wire.webhook', 'webhook.start']);
  await runtime.stopOwnedRuntime('done');

  let releaseInit;
  fixtures.initProviders = () =>
    new Promise((resolve) => {
      releaseInit = resolve;
    });
  t.after(() => {
    fixtures.initProviders = async () => {};
  });
  calls.length = 0;
  const starting = runtime.startAutomationRuntime();
  const stopping = runtime.stopOwnedRuntime('shutdown');
  releaseInit();
  await Promise.all([starting, stopping]);
  assert.deepEqual(names(), [
    'initProviders',
    'scheduler.stop',
    'snapshot.stop',
    'locks.release',
    'advert.clear',
    'ownership',
  ]);
});
