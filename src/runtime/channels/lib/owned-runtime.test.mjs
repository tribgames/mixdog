// Characterization of the owned-runtime lifecycle: connect → automation arm →
// stop/teardown ordering, mid-start stop bail, degraded (automation-only)
// start on connect failure, provider hot-swap on reload, and ownership
// refresh coalescing. Module-boundary collaborators are stubbed so the test
// pins the lifecycle's observable call order, not the collaborators.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const calls = [];
const record = (...entry) => calls.push(entry);
const names = () => calls.map((entry) => entry[0]);
const fixtures = {
  loadedConfig: null,
  nextProvider: null,
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
  constructor(_events, channelId) {
    this.queue = { channelId };
    record('pipeline.new', channelId);
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
  reloadConfig(_events, channelId) {
    record('pipeline.reload', channelId);
  }
}

const here = (rel) => new URL(rel, import.meta.url).href;
mock.module(here('./config.mjs'), {
  namedExports: {
    loadConfig: async (opts) => {
      record('loadConfig', opts?.freshSecrets);
      return fixtures.loadedConfig;
    },
    createProvider: () => {
      record('createProvider');
      return fixtures.nextProvider;
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
    refreshActiveInstance: (_id, meta) => record('advert', meta?.providerReady),
    releaseOwnedChannelLocks: () => record('locks.release'),
    clearActiveInstance: () => record('advert.clear'),
  },
});

const { createOwnedRuntime } = await import('./owned-runtime.mjs');

function makeConfig(overrides = {}) {
  return {
    webhook: { enabled: true },
    events: { rules: [] },
    channelId: 'chan-1',
    nonInteractive: [],
    interactive: [],
    ...overrides,
  };
}

function makeProvider(name, { token = 'tok', connect } = {}) {
  return {
    name,
    token,
    connect: connect ?? (async () => record('provider.connect', name)),
    disconnect: async () => record('provider.disconnect', name),
    drainPendingSends: async () => record('provider.drain', name),
  };
}

function makeHarness(t, { provider = makeProvider('discord'), config = makeConfig() } = {}) {
  t.mock.method(process.stderr, 'write', () => true);
  calls.length = 0;
  const state = {
    config,
    provider,
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
    getProvider: () => state.provider,
    setProvider: (v) => {
      state.provider = v;
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
      reloadConfig: (_a, _b, channelId, opts) => record('scheduler.reload', channelId, opts?.restart),
    },
    statusState: {
      update: (fn) => {
        const snapshot = { channelId: 'stale', transcriptPath: 'stale' };
        fn(snapshot);
        record('status.update', snapshot.channelId, snapshot.transcriptPath);
      },
    },
    logOwnership: (line) => record('ownership', line),
    currentOwnerState: () => ({}),
    wireWebhookHandlers: () => record('wire.webhook'),
    wireEventQueueHandlers: (queue) => record('wire.events', queue?.channelId),
  });
  return { state, runtime };
}

const CONNECTED_START = [
  'advert',
  'provider.connect',
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

test('startOwnedRuntime connects, advertises readiness, arms automation once and notifies acquired', async (t) => {
  const { state, runtime } = makeHarness(t);
  await runtime.startOwnedRuntime();
  assert.deepEqual(names(), CONNECTED_START);
  assert.deepEqual(calls[0], ['advert', false]);
  assert.deepEqual(calls[2], ['advert', true]);
  assert.deepEqual(calls[3], ['notify', 'notifications/mixdog/remote', 'acquired']);
  assert.deepEqual(calls.at(-1), ['ownership', `active owner lead=42 pid=${process.pid}`]);
  assert.equal(state.connected, true);
  assert.ok(state.webhookServer instanceof FakeWebhookServer);
  assert.ok(state.eventPipeline instanceof FakeEventPipeline);

  calls.length = 0;
  await runtime.startOwnedRuntime();
  assert.deepEqual(names(), [], 'an already-connected owner does not reconnect or re-arm');
});

test('stopOwnedRuntime tears automation down, drains then disconnects a connected provider, and is idempotent', async (t) => {
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
    'provider.drain',
    'provider.disconnect',
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

test('a stop landing mid-connect makes the in-flight start bail without arming automation', async (t) => {
  let releaseConnect;
  const provider = makeProvider('discord', {
    connect: () =>
      new Promise((resolve) => {
        record('provider.connect', 'discord');
        releaseConnect = resolve;
      }),
  });
  const { state, runtime } = makeHarness(t, { provider });
  const start = runtime.startOwnedRuntime();
  await runtime.stopOwnedRuntime('shutdown');
  assert.deepEqual(names(), [
    'advert',
    'provider.connect',
    'scheduler.stop',
    'snapshot.stop',
    'locks.release',
    'advert.clear',
    'ownership',
  ]);
  assert.equal(state.connected, false);

  calls.length = 0;
  releaseConnect();
  await start;
  assert.deepEqual(names(), ['provider.disconnect', 'locks.release', 'advert.clear']);
  assert.equal(state.connected, false);
  assert.ok(!names().includes('scheduler.start'));
  assert.ok(!names().includes('notify'));
});

test('a connect failure degrades to automation-only, and a later reconnect does not re-arm the scheduler', async (t) => {
  let fail = true;
  const provider = makeProvider('discord', {
    connect: async () => {
      record('provider.connect', 'discord');
      if (fail) throw new Error('gateway down');
    },
  });
  const { state, runtime } = makeHarness(t, { provider });
  await runtime.startOwnedRuntime();
  assert.deepEqual(names(), [
    'advert',
    'provider.connect',
    'provider.disconnect',
    'locks.release',
    'advert.clear',
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
  assert.equal(state.connected, false);

  fail = false;
  calls.length = 0;
  await runtime.startOwnedRuntime();
  assert.deepEqual(names(), [
    'advert',
    'provider.connect',
    'advert',
    'notify',
    'initProviders',
    'pipeline.start',
    'wire.webhook',
    'webhook.start',
    'ownership',
  ]);
  assert.equal(state.connected, true);
});

test('reloadRuntimeConfig swaps a provider whose credentials changed and reconnects the new one', async (t) => {
  const previous = makeProvider('discord', { token: 'old' });
  const { state, runtime } = makeHarness(t, { provider: previous });
  await runtime.startOwnedRuntime();
  const next = makeProvider('discord', { token: 'new' });
  fixtures.loadedConfig = makeConfig({ channelId: 'chan-2' });
  fixtures.nextProvider = next;
  calls.length = 0;
  await runtime.reloadRuntimeConfig();
  await runtime.refreshBridgeOwnership();
  assert.equal(state.provider, next);
  assert.equal(state.connected, true);
  assert.deepEqual(calls[0], ['loadConfig', true]);
  assert.deepEqual(calls[1], ['scheduler.reload', 'chan-2', true]);
  assert.equal(calls.filter((c) => c[0] === 'provider.disconnect' && c[1] === 'discord').length, 1);
  assert.ok(names().includes('provider.connect'));
  assert.ok(!names().includes('status.update'), 'same provider type keeps the routing snapshot');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'pipeline.new'),
    [['pipeline.new', 'chan-2']]
  );
});

test('reloadRuntimeConfig with an unchanged provider discards the fresh instance and hot-reloads automation services', async (t) => {
  const current = makeProvider('discord');
  const { state, runtime } = makeHarness(t, { provider: current });
  await runtime.startOwnedRuntime();
  const duplicate = makeProvider('discord');
  duplicate.disconnect = async () => record('provider.disconnect', 'duplicate');
  fixtures.loadedConfig = makeConfig({ channelId: 'chan-3' });
  fixtures.nextProvider = duplicate;
  calls.length = 0;
  await runtime.reloadRuntimeConfig();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.provider, current);
  assert.deepEqual(names(), [
    'loadConfig',
    'scheduler.reload',
    'createProvider',
    'provider.disconnect',
    'pipeline.reload',
    'wire.events',
    'pipeline.start',
    'wire.webhook',
    'webhook.reload',
    'wire.webhook',
    'webhook.start',
  ]);
  assert.deepEqual(calls[3], ['provider.disconnect', 'duplicate']);
  assert.deepEqual(calls[8], ['webhook.reload', false]);
});

test('reloadRuntimeConfig with a provider type change clears the routing snapshot', async (t) => {
  const { state, runtime } = makeHarness(t, { provider: makeProvider('discord') });
  await runtime.startOwnedRuntime();
  const other = makeProvider('telegram');
  fixtures.loadedConfig = makeConfig();
  fixtures.nextProvider = other;
  calls.length = 0;
  await runtime.reloadRuntimeConfig();
  await runtime.refreshBridgeOwnership();
  assert.equal(state.provider, other);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'status.update'),
    [['status.update', '', '']]
  );
  assert.ok(calls.some((c) => c[0] === 'provider.connect' && c[1] === 'telegram'));
});

test('refreshBridgeOwnership stops an inactive bridge once and coalesces concurrent callers', async (t) => {
  const { state, runtime } = makeHarness(t);
  await runtime.startOwnedRuntime();
  state.active = false;
  calls.length = 0;
  await Promise.all([runtime.refreshBridgeOwnership(), runtime.refreshBridgeOwnership()]);
  assert.equal(names().filter((n) => n === 'scheduler.stop').length, 1);
  assert.equal(state.connected, false);

  calls.length = 0;
  await runtime.refreshBridgeOwnership();
  assert.deepEqual(names(), [], 'an inactive, already-stopped bridge is left alone');
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
