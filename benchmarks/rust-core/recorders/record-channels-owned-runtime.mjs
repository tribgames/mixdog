#!/usr/bin/env node
// Node's owned-runtime lifecycle (src/runtime/channels/lib/owned-runtime.test.mjs, 7 cases, and a further shape: an
// arming that throws after the acquisition was announced) recorded from the REAL
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
// Every argument of every call is recorded. A function or a class instance (a server, a queue) cannot be written as data: it is
// written as {$callable: name} / {$instance: ClassName}, declared in the manifest.
const describe = (value) => {
  if (typeof value === 'function') return { $callable: value.name || 'anonymous' };
  if (Array.isArray(value)) return value.map(describe);
  if (value instanceof Error || value instanceof Date || !value || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return { $instance: value.constructor?.name ?? 'unknown' };
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, describe(v)]));
};
const record = (name, ...args) => calls.push([name, ...args.map(describe)]);
const fixtures = { loadedConfig: null, initProviders: async () => {}, webhookStartThrows: null };
let onWebhookStart = null;

class FakeWebhookServer {
  constructor(...args) { this.cfg = args[0]; record('webhook.new', ...args); }
  start(...args) {
    record('webhook.start', ...args);
    if (fixtures.webhookStartThrows) throw new Error(fixtures.webhookStartThrows);
    onWebhookStart?.();
  }
  async stop(...args) { record('webhook.stop', ...args); }
  async reloadConfig(...args) { this.cfg = args[0]; record('webhook.reload', ...args); }
}
class FakeEventPipeline {
  constructor(...args) { this.queue = {}; record('pipeline.new', ...args); }
  getQueue() { return this.queue; }
  start(...args) { record('pipeline.start', ...args); }
  stop(...args) { record('pipeline.stop', ...args); }
  reloadConfig(...args) { record('pipeline.reload', ...args); }
}

mock.module(url('./config.mjs'), { namedExports: { loadConfig: async (...args) => { record('loadConfig', ...args); return fixtures.loadedConfig; } } });
mock.module(url('./webhook.mjs'), { namedExports: { WebhookServer: FakeWebhookServer } });
mock.module(url('./event-pipeline.mjs'), { namedExports: { EventPipeline: FakeEventPipeline } });
mock.module(url('./status-snapshot.mjs'), { namedExports: { startSnapshotWriter: (...args) => record('snapshot.start', ...args), stopSnapshotWriter: (...args) => record('snapshot.stop', ...args) } });
mock.module(url('../../agent/orchestrator/providers/registry.mjs'), {
  namedExports: { initProviders: async (providers) => { record('initProviders', providers); await fixtures.initProviders(providers); } },
});
mock.module(url('../../agent/orchestrator/config.mjs'), { namedExports: { loadConfig: (...args) => { record('agent.loadConfig', ...args); return { providers: {} }; } } });
mock.module(url('./runtime-paths.mjs'), {
  namedExports: {
    refreshActiveInstance: (...args) => record('advert', ...args),
    releaseOwnedChannelLocks: (...args) => record('locks.release', ...args),
    clearActiveInstance: (...args) => record('advert.clear', ...args),
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
    sendNotifyToParent: (...args) => record('notify', ...args),
    scheduler: {
      start: (...args) => record('scheduler.start', ...args),
      stop: (...args) => record('scheduler.stop', ...args),
      reloadConfig: (...args) => record('scheduler.reload', ...args),
    },
    logOwnership: (...args) => record('ownership', ...args),
    currentOwnerState: (...args) => { record('currentOwnerState', ...args); return {}; },
    wireWebhookHandlers: (...args) => record('wire.webhook', ...args),
    wireEventQueueHandlers: (...args) => record('wire.events', ...args),
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
const w = (label, promise) => within(label, promise, 30_000);
const webhookStarted = () => within('the webhook server start after a reload', new Promise((resolve) => { onWebhookStart = resolve; }), 30_000);

const cases = [];
try {
  {
    const { state, runtime } = harness();
    const first = (await w('first startOwnedRuntime', runtime.startOwnedRuntime()), take());
    const stateAfter = snap(state);
    const second = (await w('second startOwnedRuntime', runtime.startOwnedRuntime()), take());
    cases.push({ name: 'start advertises, arms automation once and notifies acquired', steps: ['startOwnedRuntime', 'startOwnedRuntime'], calls: [first, second], state: stateAfter, stderr: [...stderr] });
  }
  {
    const { state, runtime } = harness();
    state.active = false;
    await w('startOwnedRuntime while inactive', runtime.startOwnedRuntime());
    cases.push({ name: 'start does nothing while the bridge is inactive', steps: ['channelBridgeActive=false', 'startOwnedRuntime'], calls: [take()], state: snap(state), stderr: [...stderr] });
  }
  {
    const { state, runtime } = harness();
    await w('startOwnedRuntime', runtime.startOwnedRuntime());
    const startup = take();
    await w("stopOwnedRuntime('bridge inactive')", runtime.stopOwnedRuntime('bridge inactive'));
    const first = take();
    const stateAfter = snap(state);
    await w("stopOwnedRuntime('again')", runtime.stopOwnedRuntime('again'));
    cases.push({ name: 'stop tears automation down and is idempotent', steps: ['startOwnedRuntime', "stopOwnedRuntime('bridge inactive')", "stopOwnedRuntime('again')"], calls: [startup, first, take()], state: stateAfter, stderr: [...stderr] });
  }
  {
    const init = gate();
    fixtures.initProviders = () => init.wait;
    const { state, runtime } = harness();
    const start = runtime.startOwnedRuntime();
    await w("stopOwnedRuntime('shutdown') mid-start", runtime.stopOwnedRuntime('shutdown'));
    const duringStart = take();
    const connected = state.connected;
    init.release();
    await w('the in-flight start to settle', start);
    fixtures.initProviders = async () => {};
    cases.push({ name: 'a stop landing mid-start makes the in-flight start bail without arming automation', steps: ['startOwnedRuntime (initProviders held)', "stopOwnedRuntime('shutdown')", 'initProviders released, start settles'], calls: [duringStart, take()], connectedAfterStop: connected, state: snap(state), stderr: [...stderr] });
  }
  {
    const { state, runtime } = harness();
    await w('startOwnedRuntime', runtime.startOwnedRuntime());
    fixtures.loadedConfig = makeConfig();
    const startup = take();
    const started = webhookStarted();
    await w('reloadRuntimeConfig', runtime.reloadRuntimeConfig());
    await started;
    cases.push({ name: 'reload re-arms the scheduler and hot-reloads automation services', steps: ['startOwnedRuntime', 'reloadRuntimeConfig (loaded config: webhook enabled, no schedules)'], calls: [startup, take()], state: snap(state), stderr: [...stderr] });
    onWebhookStart = null;
  }
  {
    const { state, runtime } = harness();
    fixtures.loadedConfig = makeConfig();
    await w('reloadRuntimeConfig on a stopped runtime', runtime.reloadRuntimeConfig());
    cases.push({ name: 'reload on a stopped runtime tears the webhook and event runtime down', steps: ['reloadRuntimeConfig on a runtime never started'], calls: [take()], state: snap(state), stderr: [...stderr] });
  }
  {
    const { state, runtime } = harness();
    await w('first startAutomationRuntime', runtime.startAutomationRuntime());
    const first = take();
    await w('second startAutomationRuntime', runtime.startAutomationRuntime());
    const second = take();
    await w("stopOwnedRuntime('done')", runtime.stopOwnedRuntime('done'));
    const stopped = take();
    const init = gate();
    fixtures.initProviders = () => init.wait;
    const starting = runtime.startAutomationRuntime();
    const stopping = runtime.stopOwnedRuntime('shutdown');
    init.release();
    await w('the start and the stop issued in the same tick to settle', Promise.all([starting, stopping]));
    fixtures.initProviders = async () => {};
    cases.push({ name: 'startAutomationRuntime is idempotent and a stop during its init aborts arming', steps: ['startAutomationRuntime', 'startAutomationRuntime', "stopOwnedRuntime('done')", 'startAutomationRuntime (initProviders held) with stopOwnedRuntime issued in the same tick, then released'], calls: [first, second, stopped, take()], state: snap(state), stderr: [...stderr] });
  }
  {
    // owned-start.mjs:52-58: the acquisition is announced as the bridge connects, before the arming; an arming that throws
    // afterwards is caught by startOwnedRuntime (:76-84), which rolls the connection back and announces nothing more.
    const { state, runtime } = harness();
    fixtures.webhookStartThrows = 'webhook start failed';
    try {
      await w('startOwnedRuntime whose arming throws', runtime.startOwnedRuntime());
    } finally {
      fixtures.webhookStartThrows = null;
    }
    cases.push({ name: 'an activation announced as acquired whose arming fails afterwards rolls the connection back and announces nothing more', steps: ['startOwnedRuntime (webhook start throws)'], calls: [take()], state: snap(state), stderr: [...stderr] });
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
    replay: "Public Rust entries (mixdog-services channels/runtime.rs): ChannelLifecycle::start_bridge (:349), ChannelLifecycle::stop_owned_runtime (:354), ChannelRuntime::start_automation (:166), ChannelRuntime::reload_runtime (:316) and ChannelLifecycle::reload_config (:393); the private start_bridge_turn/reload_turn are reached through them. A replay drives them over the product's own WebhookAutomation (a real WebhookService, recording settings and listener behind it) with a recording scheduler, and compares per case the ordered call list the product made (notify method and params, scheduler.reload schedules and options, the listener's start with the settings it was given and its stop), the end state and the stderr lines; what has no counterpart is in `declared`. Rust has no advert/lock files and no snapshot writer: those entries (advert, advert.clear, locks.release, snapshot.*, currentOwnerState, ownership logs) are Node-only calls, listed as work for the Rust side if parity is wanted. The acquisition (notify ↔ the core's remoteSession client event) is announced as the bridge connects, before the providers' init and the arming, on both sides (owned-start.mjs:52-56, channels/runtime.rs activate_bridge): an arming that fails afterwards (case 7) leaves it announced; only a call refused before the bridge connects announces nothing",
    declared: [{"what":"calls pipeline.new, pipeline.reload, pipeline.start, pipeline.stop, wire.events, wire.webhook; state.eventPipeline","reason":"the event pipeline: the product's webhook receiver (channels/ports.rs WebhookAutomation) has no event pipeline to construct, wire, start or stop"},{"what":"calls webhook.new (its `enabled` argument is compared with the one the product starts its listener with)","reason":"the receiver object's construction: the product has a service and a listener, and starts the listener with the settings"},{"what":"calls webhook.reload","reason":"Node's hot reload of the receiver's config; WebhookAutomation::sync_turn re-listens only when the port changed (ports.rs, `bound` check), so a reload with the recorded unchanged settings makes no listener call"},{"what":"calls webhook.start of a receiver that already listens (no webhook.new in the step)","reason":"Node's start returns at once while the server exists (webhook/listener-lifecycle.mjs:15); the product keeps its listening listener (ports.rs sync_turn), so it makes no call"},{"case":7,"what":"state.webhookServer","reason":"after the failed start Node keeps the receiver object it made, which never listened; the product has no such object, and its listener, whose start failed, does not listen"}],
    exclusions: "none beyond `declared` and the Node-only calls named in `replay`: every other logged call of every step is in the golden",
    normalised: { 'ownership line pid': 'the process id after "pid=" is replaced by <pid> (differs per run)', 'call arguments': 'a function argument is written {$callable: name}, a class instance {$instance: ClassName}; every other argument whole' },
  },
});
process.exit(0);
