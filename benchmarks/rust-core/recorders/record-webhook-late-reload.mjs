#!/usr/bin/env node
// A webhook delivery that arrives while a late reload runs: the automation runtime is up and listening, a webhook edit
// (`createChannelConfigApi.saveWebhook`) reloads the channels runtime (`reloadChannelsSoon` -> `reload_config`), and the
// reload's webhook sync (`syncWebhookAndEventRuntime({ reload: true })` -> `WebhookServer.reloadConfig`) is where the
// delivery lands. Stock Node closes the listener there and binds the same port again, so the delivery is refused; the
// product is b6f10295a with `node-patches/node-fix-webhook-late-reload.patch` applied, which keeps a listener whose port
// the reload keeps. The stack is Node's own (createChannelConfigApi, createChannelStart, createChannelsRuntimeLoader over
// the real channels runtime, a real PostgreSQL store, the real listener on a loopback port); the recorder's seams are those
// of record-schedule-save-start.mjs (the attach without the HTTP hop, the provider init held by lib/gate-hooks.mjs,
// channel-start's timers on a virtual queue) and one more: the delivery is sent the moment `WebhookServer.reloadConfig`
// has been entered, a boundary Node gives synchronously. Nothing sleeps or polls.
//
//   node benchmarks/rust-core/recorders/record-webhook-late-reload.mjs --tree <b6f10295a with the patch and node_modules> --patch benchmarks/rust-core/recorders/node-patches/node-fix-webhook-late-reload.patch [--out <file>]
//
// Output: native/core/fixtures/webhook-late-reload/golden.json (+ MANIFEST.json), or only the result at --out (a run on
// the stock tree, without --patch, shows the refusal).
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, within, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-webhook-late-reload.mjs';
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:/mixdog-build/tmp/w23/rec';
const args = parseArgs();
const tree = resolveTree(args);
// Checked before anything is loaded from the tree.
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);

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
    log.push(line.replaceAll(dataDir, '<DATA>'));
    for (const waiter of [...waiters]) if (waiter.pattern.test(line)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(line); }
  }
  return realWrite(chunk, ...rest);
};
const logLine = (pattern) => (log.some((line) => pattern.test(line)) ? Promise.resolve() : new Promise((resolve) => waiters.push({ pattern, resolve })));
const logLineAfter = (from, pattern) => (log.slice(from).some((line) => pattern.test(line)) ? Promise.resolve() : new Promise((resolve) => waiters.push({ pattern, resolve })));
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
const { WebhookServer } = await imp('src/runtime/channels/lib/webhook.mjs');
const pgAdapter = await imp('src/runtime/memory/lib/pg/adapter.mjs');
const { setAgentHomeLiveSurface } = await imp('src/session-runtime/agent-home-delivery.mjs');
const { agentHomeSessionId } = await imp('src/runtime/agent/orchestrator/session/agent-home.mjs');
createAgentEditorApi({ cfgMod: { getPluginData } }).saveLeadIdentity({ name: 'Harness Lead' });

// The session service, running: the live surface daemon.mjs:1170-1201 installs over `sessionService.submitSession`,
// whose routine submit is the boundary kept here. Each routine turn is accepted, committed and settled `done`, and kept
// in the order it was submitted. The owner's home thread is a stored session (the legacy record `loadSession` reads).
const HOME = agentHomeSessionId('lead');
mkdirSync(join(dataDir, 'sessions'), { recursive: true });
writeFileSync(join(dataDir, 'sessions', `${HOME}.json`), JSON.stringify({ id: HOME, owner: 'user', agent: 'lead', closed: false, generation: 1, updatedAt: 1, messages: [] }));
// The routine header's `Local time` (routine-trigger.mjs `now = new Date()`) is read on a virtual wall clock: a `new
// Date()` made inside routine-trigger.mjs is this instant; every other Date is real.
const WALL = 1_700_000_000_000;
const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate {
  constructor(...dateArgs) {
    if (dateArgs.length === 0 && new Error().stack.includes('/routine-trigger.mjs')) super(WALL);
    else super(...dateArgs);
  }
};
const turns = [];
const turnWaiters = [];
setAgentHomeLiveSurface({
  busy: () => false,
  notice: () => {},
  abort: () => {},
  submit: async (sessionId, prompt, options) => {
    turns.push({ sessionId, prompt, mode: options.mode, priority: options.priority, skillSelection: options.skillSelection, transcriptMeta: options.transcriptMeta });
    for (const w of turnWaiters.filter((w) => turns.length >= w.n)) { turnWaiters.splice(turnWaiters.indexOf(w), 1); w.resolve(); }
    queueMicrotask(() => { options.onCommitted?.(); options.onSettled?.({ status: 'done', result: { content: '' } }); });
    return true;
  },
});
const turnCount = (n) => (turns.length >= n ? Promise.resolve() : new Promise((resolve) => turnWaiters.push({ n, resolve })));

const loader = createChannelsRuntimeLoader({ log: () => {}, setOwnerContext: () => {} });
let attached = false;
const channels = {
  status: () => ({ running: attached }),
  start: async () => { if (!attached) { attached = true; void loader.start().catch(() => {}); } },
  execute: async (name, callArgs) => { await channels.start(); return loader.handleCall(name, callArgs); },
};
// boot/tools.mjs:69-79, with the in-flight reload kept for the recorder to await.
let lastReload = Promise.resolve();
const reloadChannelsSoon = () => {
  lastReload = (async () => {
    const reply = await channels.execute('reload_config', {});
    if (reply?.isError === true) throw new Error(reply.content?.[0]?.text || 'reload_config failed');
  })().catch((error) => process.stderr.write(`[channels] reload failed: ${error?.message || String(error)}\n`));
};
const channelStart = createChannelStart({
  timers: {},
  bootProfile: () => {},
  isCloseRequested: () => false,
  getActiveTurnCount: () => 0,
  getSessionCreatePromise: () => null,
  hasActiveAutomation: () => admin.hasActiveAutomation(),
  channels,
  envFlag: () => false,
  delays: { channelStartDelayMs: 0 },
  state: { channelStartPromise: null },
  park: () => {},
});
const api = createChannelConfigApi({ channels, reloadChannelsSoon, ensureAutomationRuntime: () => channelStart.scheduleChannelStart(0) });

const PORT = 47312;
const SECRET = 'late-reload-secret';
const BODY = '{"action":"opened"}';
const headersOf = (body) => ({
  'content-type': 'application/json',
  'x-github-event': 'issues',
  'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
});
const HEADERS = headersOf(BODY);
const listening = () => new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port: PORT }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});
// One delivery on a fresh connection: the reply, or the error the connection ended with.
const deliver = (body = BODY) => new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/webhook/gh', headers: headersOf(body), agent: false }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
  });
  req.on('error', (error) => resolve({ error: error.code ?? String(error) }));
  req.end(body);
});

// The delivery goes out once the reload's webhook sync has entered `reloadConfig`.
let delivery = null;
const reloadConfig = WebhookServer.prototype.reloadConfig;
WebhookServer.prototype.reloadConfig = function (...callArgs) {
  const reloaded = reloadConfig.apply(this, callArgs);
  delivery ??= deliver();
  return reloaded;
};

await admin.setWebhookConfigAsync({ port: PORT });
const ENTRY = { name: 'gh', instructions: 'Triage the issue.', secret: SECRET };
const result = { port: PORT, entry: ENTRY, body: BODY, headers: HEADERS, home: HOME, wallClock: WALL, timeZone: process.env.TZ };
result.saveReply = await api.saveWebhook(ENTRY);
await entered.promise;
await fireVirtualTimers();
await lastReload;
releaseInit.resolve();
await logLine(/automation runtime up/);
await logLine(/webhook: listening on/);
result.listeningBefore = await listening();

// The edit's reload, late: the runtime is up and its receiver listens.
result.edit = { ...ENTRY, instructions: 'Triage the issue again.', overwrite: true };
result.editReply = await api.saveWebhook(result.edit);
await fireVirtualTimers();
await lastReload;
if (!delivery) throw new Error('the reload never reached WebhookServer.reloadConfig');
result.delivery = await delivery;
result.listeningAfter = await listening();

// Every reload of the receiver, as it is entered and as it ends; the delivery its entry sends carries `nextBody`.
let nextBody = BODY;
const reloadsEntered = [];
let reloadsEnded = 0;
const reloadEnded = [];
const reloadEntered = [];
WebhookServer.prototype.reloadConfig = function (config, ...rest) {
  reloadsEntered.push(config.port ?? null);
  for (const w of reloadEntered.splice(0)) w();
  const reloaded = reloadConfig.call(this, config, ...rest);
  delivery ??= deliver(nextBody);
  return Promise.resolve(reloaded).finally(() => { reloadsEnded += 1; for (const w of reloadEnded.splice(0)) w(); });
};
const reloadsSettled = async () => {
  await lastReload;
  while (reloadsEnded < reloadsEntered.length) await new Promise((resolve) => reloadEnded.push(resolve));
};

// The settings route (`setWebhookConfig`, the app's webhook settings): the port is kept.
delivery = null;
reloadsEntered.length = 0; reloadsEnded = 0;
result.settingsUpdate = { patch: { port: PORT } };
result.settingsUpdate.reply = await api.setWebhookConfig(result.settingsUpdate.patch);
await reloadsSettled();
if (!delivery) throw new Error('the settings reload never reached WebhookServer.reloadConfig');
result.settingsUpdate.delivery = await delivery;
result.settingsUpdate.reloads = reloadsEntered.length;
result.settingsUpdate.listeningAfter = await listening();

// A move to a port whose whole range (Node walks 8 ports) is taken, then back.
const OTHER = PORT + 100;
const blockers = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve) => {
  const server = createServer();
  server.listen(OTHER + i, '127.0.0.1', () => resolve(server));
})));
const listensOn = (port) => new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});
const steps = [];
for (const port of [OTHER, PORT]) {
  delivery = null;
  reloadsEntered.length = 0; reloadsEnded = 0;
  const from = log.length;
  const reply = await api.setWebhookConfig({ port });
  await reloadsSettled();
  await (port === OTHER ? logLineAfter(from, /all ports .* in use/) : logLineAfter(from, /webhook: listening on/));
  steps.push({
    patch: { port },
    reply,
    // No reload count here: a port change also reaches the worker's config watch, whose reload coalesces with the
    // route's own by timing (1 to 3 `reloadConfig` calls across runs of the same tree).
    // The delivery the reload's entry sent to the old port (its listener closing), and one sent once it ended.
    afterReload: await deliver(),
    listeningOnFirst: await listensOn(PORT),
    log: log.slice(from).filter((line) => /^mixdog webhook: /.test(line)).map((line) => line.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')),
  });
}
for (const server of blockers) server.close();
result.portBounce = { otherPort: OTHER, blocked: 8, steps };

// An external config edit: another process changes the channels section in the file on disk (port kept); the worker's
// config watch (config-reload-watch.mjs) hears it and reloads the runtime, whose webhook sync is where the delivery
// lands: a delivery not seen before, so it runs a routine turn in the owner's home thread, once.
delivery = null;
reloadsEntered.length = 0; reloadsEnded = 0;
const EDIT_BODY = '{"action":"edited"}';
nextBody = EDIT_BODY;
const turnsBefore = turns.length;
const sharedConfig = pathToFileURL(join(tree, 'src/runtime/shared/config.mjs')).href;
result.configEdit = { section: 'channels', set: { revision: 1 }, body: EDIT_BODY, headers: headersOf(EDIT_BODY) };
const write = `const { updateSection } = await import(${JSON.stringify(sharedConfig)}); updateSection('channels', (section) => ({ ...section, revision: 1 }));`;
const entered1 = new Promise((resolve) => reloadEntered.push(resolve));
const child = spawnSync(process.execPath, ['--input-type=module', '-e', write], { env: { ...process.env }, encoding: 'utf8', timeout: 30_000 });
if (child.status !== 0) throw new Error(`the external config write failed: ${child.stderr || child.stdout}`);
await entered1;
await reloadsSettled();
result.configEdit.delivery = await delivery;
result.configEdit.reloads = reloadsEntered.length;
result.configEdit.listeningAfter = await listening();
await within('the config edit delivery\'s routine turn', turnCount(turnsBefore + 1));
result.configEdit.turns = turns.slice(turnsBefore);
result.turns = turns;
result.log =log.filter((line) => /^mixdog webhook: /.test(line)).map((line) => line.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>'));

const out = args.get('out');
if (out) {
  writeFileSync(out, JSON.stringify(result, null, 1));
} else {
  const finalDir = join(FIXTURES_ROOT, 'webhook-late-reload');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), result);
  writeSetManifest(stage, {
    set: 'webhook-late-reload',
    recorder,
    command: `node ${recorder} --tree <b6f10295a with the patch> --patch ${identity.patch?.file ?? '<none>'}`,
    identity,
    extra: { ...recorderProvenance(import.meta.url) },
  });
  commitStage(stage, finalDir);
}
try { await (await loader.ensure()).stop(); } catch {}
await pgAdapter.shutdownOwnedPg({ timeoutMs: 20_000 }).catch(() => {});
process.exit(0);
