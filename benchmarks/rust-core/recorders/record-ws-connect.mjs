#!/usr/bin/env node
// How a Responses WebSocket is opened (`openai-ws-pool.mjs` `acquireWebSocket` -> `_openSocket` -> `openHedged`), recorded from
// the b6f tree for the Rust OpenAI adapter's dial (`mixdog-ai` `providers::openai::hedge`). The product's own acquire runs
// with only the network end scripted: the TLS connect of `createWsConnection` is a plain loopback connect (the `ws` client
// writes its upgrade the same way over either), and a loopback server decides per connection what the upgrade gets:
// nothing (a stuck upgrade), a completed upgrade, an HTTP status, or a reset. Node's time is virtual: `setTimeout` and
// `Date.now` follow `clock`, a timer runs only when `advance` reaches it (due time, then registration order), and the real
// loopback I/O is let to settle between timers. Every scenario records the upgrade requests the server saw and when (ms of
// virtual time since the acquire began), when each connection was closed by the client, and how the acquire ended.
//
//   node benchmarks/rust-core/recorders/record-ws-connect.mjs --tree <b6f tree> [--only <scenario id>]
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-ws-connect.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only');
const T0 = Date.parse('2026-11-09T12:00:00Z');

// ---- virtual time ----
const realSetTimeout = globalThis.setTimeout;
const clock = { now: T0, seq: 0, timers: new Map() };
Date.now = () => clock.now;
globalThis.setTimeout = (fn, ms = 0, ...rest) => {
  const id = ++clock.seq;
  clock.timers.set(id, { id, due: clock.now + Math.max(0, Number(ms) || 0), fn, rest });
  return { id, unref() { return this; }, ref() { return this; }, hasRef: () => true, refresh() { return this; }, [Symbol.toPrimitive]: () => id };
};
globalThis.clearTimeout = (timer) => void clock.timers.delete(timer?.id ?? timer);
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 100));
/** Runs every timer due by `target` (ms since `T0`), each at its own time, letting the loopback I/O settle after each. */
async function advanceTo(target) {
  for (;;) {
    const due = [...clock.timers.values()].filter((t) => t.due <= base + target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
    if (!due) break;
    clock.timers.delete(due.id);
    clock.now = Math.max(clock.now, due.due);
    due.fn(...due.rest);
    await settle();
  }
  clock.now = base + target;
  await settle();
}
let base = T0;
const since = () => clock.now - base;

// ---- the loopback server: what each upgrade gets ----
const log = [];
let script = [];
let seen = 0;
const { WebSocketServer } = await import(pathToFileURL(join(tree, 'node_modules/ws/wrapper.mjs')).href);
const wss = new WebSocketServer({ noServer: true });
const server = http.createServer();
server.on('upgrade', (req, socket, head) => {
  upgradePorts.add(socket.remotePort);
  const n = ++seen;
  const action = script[n - 1] ?? 'stuck';
  log.push({ t: since(), on: 'upgrade', conn: n, action });
  socket.on('close', () => log.push({ t: since(), on: 'closed', conn: n }));
  socket.on('error', () => {});
  if (action === 'open') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      log.push({ t: since(), on: 'opened', conn: n });
      ws.on('error', () => {});
    });
  } else if (action === 'reset') {
    socket.destroy();
  } else if (action.startsWith('status ')) {
    const code = Number(action.slice(7));
    socket.end(`HTTP/1.1 ${code} Fixture\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
// The product dials TLS to the provider's host; the recorder's connect is a plain one to the loopback server.
let dialed = 0;
// A connection that never asks to upgrade (the Codex route's connection warm-up) is no WebSocket leg: its dial is left out.
const upgradePorts = new Set();
server.on('request', (_req, res) => res.end());
tls.connect = () => {
  // The leg's own start: the moment the product asks for a connection.
  const entry = { t: since(), on: 'dial', conn: ++dialed };
  log.push(entry);
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { entry.port = socket.localPort; });
  return socket;
};
syncBuiltinESMExports();

for (const k of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|^MIXDOG_/.test(k)) delete process.env[k];
const pool = await import(pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers/openai-ws-pool.mjs')).href);

const AUTHS = { 'openai-direct': { type: 'openai-direct', apiKey: 'fixture-key' }, 'openai-oauth': { type: 'openai-oauth', accessToken: 'fixture-token', accountId: 'acct-fixture' } };
const scenarios = [
  { id: 'stuck-then-open', auth: 'openai-direct', script: ['stuck', 'open'], until: 3000 },
  { id: 'stuck-twice-then-open', auth: 'openai-oauth', script: ['stuck', 'stuck', 'open'], until: 6000 },
  { id: 'all-stuck', auth: 'openai-direct', script: [], until: 16000 },
  { id: 'all-stuck-oauth', auth: 'openai-oauth', script: [], until: 16000 },
  { id: 'status-ends-the-race', auth: 'openai-direct', script: ['stuck', 'status 429'], until: 3000 },
  { id: 'lone-leg-reset', auth: 'openai-direct', script: ['reset'], until: 100 },
  { id: 'reset-beside-a-stuck-leg', auth: 'openai-direct', script: ['stuck', 'reset'], until: 16000 },
];

const finalDir = join(FIXTURES_ROOT, 'provider-ws-connect');
const outDir = stageSet(finalDir, only ? [`${only}.json`] : null);
const recorded = [];
for (const s of scenarios) {
  if (only && s.id !== only) continue;
  log.length = 0;
  seen = 0;
  dialed = 0;
  script = s.script;
  clock.timers.clear();
  base = clock.now;
  const start = 0;
  let outcome = null;
  const acquired = pool
    .acquireWebSocket({ auth: AUTHS[s.auth], poolKey: null, cacheKey: `shared-${s.id}`, codexHeaders: {} })
    .then(
      (value) => { outcome = { ok: true, t: since() - start, reused: value.reused }; return value; },
      (error) => { outcome = { ok: false, t: since() - start, message: String(error?.message ?? error), code: error?.code ?? null, httpStatus: error?.httpStatus ?? null }; }
    );
  await settle();
  await advanceTo(s.until);
  const done = await Promise.race([acquired.then(() => true), settle().then(() => false)]);
  if (!done) outcome = { ok: null, t: null, pending: true };
  const entry = outcome?.ok ? await acquired : null;
  if (entry) pool.releaseWebSocket({ entry: entry.entry, poolKey: null, keep: false });
  await advanceTo(s.until + 1);
  const legs = log.filter((e) => !(e.on === 'dial' && !upgradePorts.has(e.port)));
  let leg = 0;
  const events = legs.map(({ port: _port, ...e }) => (e.on === 'dial' ? { ...e, conn: ++leg } : e));
  writeJson(join(outDir, `${s.id}.json`), { id: s.id, auth: s.auth, script: s.script, until: s.until, events, outcome });
  console.log(`${s.id}: ${JSON.stringify(outcome)}`);
  recorded.push(s.id);
  pool._clearWebSocketPoolForTest();
}
writeSetManifest(outDir, {
  set: 'provider-ws-connect',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <b6f tree>`,
  extra: {
    scenarios: recorded.sort(),
    clockStartMs: T0,
    exclusions: {
      'outcome.message of a transport failure (lone-leg-reset, reset-beside-a-stuck-leg)': 'the text is `ws`/libuv wording for the reset the recorder wrote; the core states the typed transport fault and its own words. The replay compares that the race ended, when, and with a transport (not status, not acquire-timeout) failure',
      'dial events of a connection that never asks to upgrade': 'the Codex route warms its connection with a plain HTTP request on the first acquire (preconnect), which dials once without being a WebSocket leg; the core runs that warm-up on its HTTP client, apart from the dial, so only the legs are compared',
      'events of kind upgrade': 'the server\'s view of a request arriving, in real I/O time after the dial; the dial events (the product asking for a connection, at the virtual time of the leg\'s start) are compared instead',
      'events of kind closed': 'the server\'s view of a closed connection. In Node a cancelled stuck leg (`socket.terminate()` before the upgrade) leaves its loopback connection open, the core drops the dial and closes it; the other closes follow the recorder\'s own release of the opened socket. Not compared: the replay compares the upgrades the server saw, when, and how the acquire ended',
      'events of kind opened': 'the server completing the upgrade; the same fact as the upgrade whose action is open',
      'MIXDOG_PROVIDER_WS_HEDGE_MS / MIXDOG_PROVIDER_WS_ACQUIRE_TIMEOUT_MS': 'module-load constants of the Node tree; every scenario runs on the defaults (3000 ms hedge, 15000 ms acquire). The core reads the same settings through the adapter context and its tests use the defaults too',
    },
    ...recorderProvenance(import.meta.url),
  },
  identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146'),
});
commitStage(outDir, finalDir);
server.closeAllConnections?.();
server.close();
process.exit(0);
