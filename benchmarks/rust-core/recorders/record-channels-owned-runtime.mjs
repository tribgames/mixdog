#!/usr/bin/env node
// Node's owned-runtime lifecycle (src/runtime/channels/lib/owned-runtime.test.mjs, 7 cases) recorded from the REAL
// `createOwnedRuntime` (owned-runtime.mjs and its owned-runtime/ phases). Its collaborators outside the lifecycle are
// the test's own module-boundary stand-ins (config load, webhook server, event pipeline, status snapshot writer,
// provider init, runtime paths, scheduler): they only log the call, so the recording is the order and arguments of
// the lifecycle's calls plus the state it leaves behind and what it wrote to stderr.
//
//   node --experimental-test-module-mocks benchmarks/rust-core/recorders/record-channels-owned-runtime.mjs --tree <dir>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';
import { begin, finish, importFrom, within } from './lib/mc-record.mjs';

const ctx = begin();
const url = (rel) => pathToFileURL(join(ctx.tree, 'src/runtime/channels/lib', rel)).href;

const calls = [];
const stderr = [];
const record = (...entry) => calls.push(entry);
const fixtures = { loadedConfig: null, initProviders: async () => {} };
let onWebhookStart = null;

class FakeWebhookServer {
  constructor(cfg) { this.cfg = cfg; record('webhook.new'); }
  start() { record('webhook.start'); onWebhookStart?.(); }
  async stop() { record('webhook.stop'); }
  async reloadConfig(cfg, opts) { this.cfg = cfg; record('webhook.reload', opts?.autoStart); }
}
class FakeEventPipeline {
  constructor() { this.queue = {}; record('pipeline.new'); }
  getQueue() { return this.queue; }
  start() { record('pipeline.start'); }
  stop() { record('pipeline.stop'); }
  reloadConfig() { record('pipeline.reload'); }
}

mock.module(url('./config.mjs'), { namedExports: { loadConfig: async () => { record('loadConfig'); return fixtures.loadedConfig; } } });
mock.module(url('./webhook.mjs'), { namedExports: { WebhookServer: FakeWebhookServer } });
mock.module(url('./event-pipeline.mjs'), { namedExports: { EventPipeline: FakeEventPipeline } });
mock.module(url('./status-snapshot.mjs'), { namedExports: { startSnapshotWriter: () => record('snapshot.start'), stopSnapshotWriter: () => record('snapshot.stop') } });
mock.module(url('../../agent/orchestrator/providers/registry.mjs'), {
  namedExports: { initProviders: async (providers) => { record('initProviders'); await fixtures.initProviders(providers); } },
});
mock.module(url('../../agent/orchestrator/config.mjs'), { namedExports: { loadConfig: () => ({ providers: {} }) } });
mock.module(url('./runtime-paths.mjs'), {
  namedExports: {
    refreshActiveInstance: () => record('advert'),
    releaseOwnedChannelLocks: () => record('locks.release'),
    clearActiveInstance: () => record('advert.clear'),
  },
});

const { createOwnedRuntime } = await importFrom(ctx.tree, 'src/runtime/channels/lib/owned-runtime.mjs');

const makeConfig = (overrides = {}) => ({ webhook: { enabled: true }, events: { rules: [] }, schedules: [], ...overrides });
const realWrite = process.stderr.write.bind(process.stderr);

function harness() {
  calls.length = 0;
  stderr.length = 0;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  const state = { config: makeConfig(), connected: false, webhookServer: null, eventPipeline: null, active: true };
  const runtime = createOwnedRuntime({
    getConfig: () => state.config,
    setConfig: (v) => { state.config = v; },
    getBridgeRuntimeConnected: () => state.connected,
    setBridgeRuntimeConnected: (v) => { state.connected = v; },
    getWebhookServer: () => state.webhookServer,
    setWebhookServer: (v) => { state.webhookServer = v; },
    getEventPipeline: () => state.eventPipeline,
    setEventPipeline: (v) => { state.eventPipeline = v; },
    getChannelBridgeActive: () => state.active,
    instanceId: 'inst-1',
    TERMINAL_LEAD_PID: 42,
    sendNotifyToParent: (method, params) => record('notify', method, params?.state),
    scheduler: {
      start: () => record('scheduler.start'),
      stop: () => record('scheduler.stop'),
      reloadConfig: (schedules, opts) => record('scheduler.reload', opts?.restart),
    },
    logOwnership: (line) => record('ownership', line),
    currentOwnerState: () => ({}),
    wireWebhookHandlers: () => record('wire.webhook'),
    wireEventQueueHandlers: () => record('wire.events'),
  });
  return { state, runtime };
}

const norm = (entry) => entry.map((part) => (typeof part === 'string' ? part.replace(`pid=${process.pid}`, 'pid=<pid>') : part));
const snap = (state) => ({
  connected: state.connected,
  webhookServer: state.webhookServer ? 'FakeWebhookServer' : null,
  eventPipeline: state.eventPipeline ? 'FakeEventPipeline' : null,
});
const take = () => { const out = calls.map(norm); calls.length = 0; return out; };
const gate = () => { let release; const wait = new Promise((resolve) => { release = resolve; }); return { wait, release }; };
const webhookStarted = () => within('the webhook server start after a reload', new Promise((resolve) => { onWebhookStart = resolve; }), 30_000);

const cases = [];
try {
  {
    const { state, runtime } = harness();
    const first = (await runtime.startOwnedRuntime(), take());
    const stateAfter = snap(state);
    const second = (await runtime.startOwnedRuntime(), take());
    cases.push({ name: 'start advertises, arms automation once and notifies acquired', steps: ['startOwnedRuntime', 'startOwnedRuntime'], calls: [first, second], state: stateAfter, stderr: [...stderr] });
  }
  {
    const { state, runtime } = harness();
    state.active = false;
    await runtime.startOwnedRuntime();
    cases.push({ name: 'start does nothing while the bridge is inactive', steps: ['channelBridgeActive=false', 'startOwnedRuntime'], calls: [take()], state: snap(state), stderr: [...stderr] });
  }
  {
    const { state, runtime } = harness();
    await runtime.startOwnedRuntime();
    take();
    await runtime.stopOwnedRuntime('bridge inactive');
    const first = take();
    const stateAfter = snap(state);
    await runtime.stopOwnedRuntime('again');
    cases.push({ name: 'stop tears automation down and is idempotent', steps: ['startOwnedRuntime', "stopOwnedRuntime('bridge inactive')", "stopOwnedRuntime('again')"], calls: [first, take()], state: stateAfter, stderr: [...stderr] });
  }
  {
    const init = gate();
    fixtures.initProviders = () => init.wait;
    const { state, runtime } = harness();
    const start = runtime.startOwnedRuntime();
    await runtime.stopOwnedRuntime('shutdown');
    const duringStart = take();
    const connected = state.connected;
    init.release();
    await start;
    fixtures.initProviders = async () => {};
    cases.push({ name: 'a stop landing mid-start makes the in-flight start bail without arming automation', steps: ['startOwnedRuntime (initProviders held)', "stopOwnedRuntime('shutdown')", 'initProviders released, start settles'], calls: [duringStart, take()], connectedAfterStop: connected, state: snap(state), stderr: [...stderr] });
  }
  {
    const { state, runtime } = harness();
    await runtime.startOwnedRuntime();
    fixtures.loadedConfig = makeConfig();
    take();
    const started = webhookStarted();
    await runtime.reloadRuntimeConfig();
    await started;
    cases.push({ name: 'reload re-arms the scheduler and hot-reloads automation services', steps: ['startOwnedRuntime', 'reloadRuntimeConfig (loaded config: webhook enabled, no schedules)'], calls: [take()], state: snap(state), stderr: [...stderr] });
    onWebhookStart = null;
  }
  {
    const { state, runtime } = harness();
    fixtures.loadedConfig = makeConfig();
    await runtime.reloadRuntimeConfig();
    cases.push({ name: 'reload on a stopped runtime tears the webhook and event runtime down', steps: ['reloadRuntimeConfig on a runtime never started'], calls: [take()], state: snap(state), stderr: [...stderr] });
  }
  {
    const { state, runtime } = harness();
    await runtime.startAutomationRuntime();
    const first = take();
    await runtime.startAutomationRuntime();
    const second = take();
    await runtime.stopOwnedRuntime('done');
    take();
    const init = gate();
    fixtures.initProviders = () => init.wait;
    const starting = runtime.startAutomationRuntime();
    const stopping = runtime.stopOwnedRuntime('shutdown');
    init.release();
    await Promise.all([starting, stopping]);
    fixtures.initProviders = async () => {};
    cases.push({ name: 'startAutomationRuntime is idempotent and a stop during its init aborts arming', steps: ['startAutomationRuntime', 'startAutomationRuntime', "stopOwnedRuntime('done')", 'startAutomationRuntime (initProviders held) with stopOwnedRuntime issued in the same tick, then released'], calls: [first, second, take()], state: snap(state), stderr: [...stderr] });
  }
} finally {
  process.stderr.write = realWrite;
}

finish(ctx, {
  url: import.meta.url,
  set: 'channels-owned-runtime',
  flags: '--experimental-test-module-mocks ',
  golden: { domain: 'channels-owned-runtime', source: 'src/runtime/channels/lib/owned-runtime.test.mjs', cases },
  extra: {
    entry: {
      runs: 'createOwnedRuntime (owned-runtime.mjs) with its owned-runtime/ phases: startOwnedRuntime, stopOwnedRuntime, startAutomationRuntime, reloadRuntimeConfig, over the same dependency bag worker.mjs hands it (getters/setters, notify, scheduler, logOwnership)',
      notRun: 'the collaborators behind module boundaries (config file load, WebhookServer, EventPipeline, status snapshot writer, provider init, runtime-paths advert/lock files, scheduler): each only appends its name and arguments to the call log, as the Node test does; advert and ownership files are Node-only',
    },
    replay: 'mixdog-services channels: ch/runtime.rs start_bridge_turn, stop_owned_runtime, reload_runtime/reload_turn and the automation start, driven with a recording scheduler/webhook/pipeline; compares per case the ordered call list (names and arguments, notify method+state, scheduler.reload restart flag, webhook.reload autoStart), the end state and the stderr lines. Rust has no advert/lock files and no snapshot writer: those entries are the Node-only calls (advert, advert.clear, locks.release, snapshot.*) a replay maps or drops by name',
    exclusions: 'none: every logged call of every step is in the golden',
    normalised: { 'ownership line pid': 'the process id after "pid=" is replaced by <pid> (differs per run)' },
  },
});
process.exit(0);
