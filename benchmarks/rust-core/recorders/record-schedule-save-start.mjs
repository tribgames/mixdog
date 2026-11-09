#!/usr/bin/env node
// Node's schedule save -> reload -> deferred automation start, at the boundaries a readback can fall on, and a stop that
// lands during the start. The session side is Node's own createChannelConfigApi + createChannelStart (prewarm/channel-start.mjs);
// the daemon side is Node's own createChannelsRuntimeLoader over the real channels runtime (worker-main.mjs: owned-runtime
// start/stop/reload, Scheduler, WebhookServer, relay tunnel) on a real PostgreSQL store in a temporary data directory. Only
// two seams are the recorder's:
//  - the attach (`channels.start`/`execute`) is the transport's register -> `onClientRegistered` -> `channelsRuntime.start()`
//    (daemon.mjs:920) without the HTTP hop;
//  - `initProviders` (the first await of startAutomationRuntime) is held by a loader hook (lib/gate-hooks.mjs), and the
//    stamp write is held by a table lock taken from the recorder's own connection (the stamp UPDATE waits in PG's lock queue).
// Every boundary is a signal Node itself gives: the `initProviders` entry, the `public hook base` / `automation runtime up`
// log lines, the lock queue. Nothing sleeps or polls. channel-start's own `setTimeout` goes through a virtual queue (due time,
// then registration order, one callback at a time, released by the recorder).
//
//   node benchmarks/rust-core/recorders/record-schedule-save-start.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/schedule-save-start/golden.json (+ MANIFEST.json, identity exact at the commit).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-schedule-save-start.mjs';
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:/mixdog-build/tmp/webhook-url-tmp/rec';
const args = parseArgs();
const tree = resolveTree(args);
const scenario = args.get('scenario');

if (!scenario) {
  const identity = exactProductIdentity(tree, NODE_COMMIT);
  const out = {};
  for (const name of ['start-after-save', 'stop-during-provider-init', 'save-during-provider-init']) {
    const file = join(mkdtempSync(join(SCRATCH, 'out-')), 'result.json');
    execFileSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\//, ''), '--tree', tree, '--scenario', name, '--out', file], { stdio: 'inherit', env: { ...process.env, MIXDOG_RECORDER_SCRATCH: SCRATCH } });
    out[name] = JSON.parse(readFileSync(file, 'utf8'));
  }
  const finalDir = join(FIXTURES_ROOT, 'schedule-save-start');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), { relayUrl: 'ws://127.0.0.1:9', timezone: 'Asia/Seoul', scenarios: out });
  writeSetManifest(stage, { set: 'schedule-save-start', recorder, command: `node ${recorder} --tree <tree>`, identity });
  commitStage(stage, finalDir);
  process.exit(0);
}

// ---- one scenario, in a process of its own (a fresh data directory and PostgreSQL cluster) ----
const dataDir = mkdtempSync(join(SCRATCH, 'data-')).replaceAll('\\', '/');
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dataDir,
  MIXDOG_HOME: dataDir,
  MIXDOG_RUNTIME_ROOT: mkdtempSync(join(SCRATCH, 'rt-')).replaceAll('\\', '/'),
  MIXDOG_DAEMON_HOST: '1',
  MIXDOG_RELAY_URL: 'ws://127.0.0.1:9',
  TZ: 'Asia/Seoul',
});
register(new URL('./lib/gate-hooks.mjs', import.meta.url));
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);

const log = [];
const waiters = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  for (const line of String(chunk).split('\n').filter(Boolean)) {
    log.push({ line:line.replaceAll(dataDir, '<DATA>') });
    for (const waiter of [...waiters]) if (waiter.pattern.test(line)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(line); }
  }
  return realWrite(chunk, ...rest);
};
const seen = (pattern) => log.some((entry) => pattern.test(entry.line));
const logLine = (pattern) => (seen(pattern) ? Promise.resolve() : new Promise((resolve) => waiters.push({ pattern, resolve })));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// channel-start's timers: a virtual queue.
const queue = [];
let order = 0;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms = 0, ...rest) => {
  if (!new Error().stack.includes('/prewarm/channel-start.mjs')) return realSetTimeout(fn, ms, ...rest);
  const handle = { virtual: true, unref: () => handle, ref: () => handle, hasRef: () => false };
  queue.push({ due: Number(ms) || 0, order: order++, fn, rest, handle });
  return handle;
};
globalThis.clearTimeout = (handle) => {
  if (handle?.virtual) { const at = queue.findIndex((entry) => entry.handle === handle); if (at >= 0) queue.splice(at, 1); return; }
  return realClearTimeout(handle);
};
const fireVirtualTimers = async () => {
  while (queue.length) {
    queue.sort((a, b) => a.due - b.due || a.order - b.order);
    const entry = queue.shift();
    entry.fn(...entry.rest);
    await Promise.resolve();
  }
};

const entered = defer();
const releaseInit = defer();
globalThis.__mixdogGate = { providerInit: () => { entered.resolve(); return releaseInit.promise; } };

const admin = await imp('src/session-runtime/services/channel-admin.mjs');
const { createChannelConfigApi } = await imp('src/session-runtime/channel-config-api.mjs');
const { createChannelStart } = await imp('src/session-runtime/prewarm/channel-start.mjs');
const { createChannelsRuntimeLoader } = await imp('src/standalone/daemon-channels-loader.mjs');
const { createAgentEditorApi } = await imp('src/session-runtime/workflow-agents-api/agent-editor.mjs');
const { getPluginData } = await imp('src/runtime/agent/orchestrator/config.mjs');
const schedulesDb = await imp('src/runtime/channels/lib/schedules-db.mjs');
const pgAdapter = await imp('src/runtime/memory/lib/pg/adapter.mjs');
createAgentEditorApi({ cfgMod: { getPluginData } }).saveLeadIdentity({ name: 'Harness Lead' });

const loader = createChannelsRuntimeLoader({ log: () => {}, setOwnerContext: () => {} });
let attached = false;
const channels = {
  status: () => ({ running: attached }),
  start: async () => { if (!attached) { attached = true; void loader.start().catch(() => {}); } },
  execute: async (name, callArgs) => { await channels.start(); return loader.handleCall(name, callArgs); },
};
// boot/tools.mjs:69-79, with the in-flight reload kept for the recorder to await.
let lastReload = Promise.resolve();
const reloadChannels = async () => {
  const reply = await channels.execute('reload_config', {});
  if (reply?.isError === true) throw new Error(reply.content?.[0]?.text || 'reload_config failed');
};
const reloadChannelsSoon = () => {
  lastReload = reloadChannels().catch((error) => process.stderr.write(`[channels] schedule reload failed: ${error?.message || String(error)}\n`));
};
const parked = new Map();
const profile = [];
const channelStart = createChannelStart({
  timers: {},
  bootProfile: (event, detail) => profile.push(detail ? [event, detail] : [event]),
  isCloseRequested: () => false,
  getActiveTurnCount: () => 0,
  getSessionCreatePromise: () => null,
  hasActiveAutomation: () => admin.hasActiveAutomation(),
  channels,
  envFlag: () => false,
  delays: { channelStartDelayMs: 0 },
  state: { channelStartPromise: null },
  park: (key, run) => parked.set(key, run),
});
const api = createChannelConfigApi({ channels, reloadChannelsSoon, ensureAutomationRuntime: () => channelStart.scheduleChannelStart(0) });

const PORT = 47311;
await admin.setWebhookConfigAsync({ port: PORT });
const ENTRY = { name: 'harness-schedule', description: 'A schedule', time: '0 9 * * *', instructions: 'Say hello.' };
const identityFile = () => existsSync(join(dataDir, 'relay-hook-device.json'));
const listening = () => new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port: PORT }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});
const observe = async (label) => ({ label, setup: await api.getChannelSetup(), identityFile: identityFile(), listening: await listening(), virtualTimers: queue.length, attached });

const result = { entry: ENTRY, timezone: process.env.TZ, steps: [] };
const db = await schedulesDb.openSchedulesDb();
const holdStamps = async () => {
  const locked = defer();
  const unlock = defer();
  // SHARE conflicts with the stamp UPDATE's ROW EXCLUSIVE and not with a read.
  const held = db.transaction(async (tx) => { await tx.query('LOCK TABLE scheduler.schedules IN SHARE MODE'); locked.resolve(); await unlock.promise; });
  await locked.promise;
  return {
    // The stamp is persisted once a SHARE lock asked for after it is granted: PG queues it behind the waiting UPDATE.
    async persisted() { unlock.resolve(); await held; await db.transaction(async (tx) => { await tx.query('LOCK TABLE scheduler.schedules IN SHARE MODE'); }); },
  };
};

if (scenario === 'start-after-save') {
  result.saveReply = await api.saveSchedule(ENTRY);
  await entered.promise; // Node's start is in the provider init
  result.steps.push(await observe('start-pending'));
  await fireVirtualTimers();
  await lastReload.catch(() => {});
  const stamps = await holdStamps();
  result.releasedAt = Date.now();
  releaseInit.resolve();
  await logLine(/automation runtime up/);
  result.steps.push(await observe('identity-persisted-stamp-pending'));
  await stamps.persisted();
  result.persistedAt = Date.now();
  result.steps.push(await observe('stamp-persisted'));
} else if (scenario === 'stop-during-provider-init') {
  result.saveReply = await api.saveSchedule(ENTRY);
  await entered.promise;
  const module = await loader.ensure();
  const stopped = module.stop();
  let stopSettled = false;
  void stopped.then(() => { stopSettled = true; });
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  result.stopSettledWhileInit = stopSettled;
  result.steps.push(await observe('stop-issued-start-pending'));
  releaseInit.resolve();
  await stopped;
  result.steps.push(await observe('after-stop'));
} else if (scenario === 'save-during-provider-init') {
  void loader.start().catch(() => {}); // the daemon's own start with no schedule yet
  attached = true;
  await entered.promise; // worker-main has loaded its config (no schedule)
  result.saveReply = await api.saveSchedule(ENTRY);
  await lastReload;
  result.steps.push(await observe('saved-start-pending'));
  const stamps = await holdStamps();
  result.releasedAt = Date.now();
  releaseInit.resolve();
  await logLine(/automation runtime up/);
  result.steps.push(await observe('started-stamp-pending'));
  await stamps.persisted();
  result.persistedAt = Date.now();
  result.steps.push(await observe('stamp-persisted'));
}
result.log = log.filter((entry) => /^mixdog( webhook| scheduler)?: /.test(entry.line)).map((entry) => entry.line.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>'));
writeFileSync(args.get('out'), JSON.stringify(result, null, 1));
try { await (await loader.ensure()).stop(); } catch {}
await pgAdapter.shutdownOwnedPg({ timeoutMs: 20_000 }).catch(() => {});
process.exit(0);
