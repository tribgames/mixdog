#!/usr/bin/env node
// Node half of the wire parity check: the real provider classes of Node (b6f10295a) and the real clients under them
// (undici's `fetch`, the `ws` package) send each scenario to a loopback server (wire-server.mjs) that records the bytes it
// receives. The only substitution is the connection: `tls.connect` hands the client a plain socket to the loopback server,
// so the clients write what they would write inside TLS to the real host (url, `Host`, headers, upgrade request, frames).
//
// Inputs that are fixed, not observed: the clock (`Date.now`), `randomUUID`, the host the User-Agent describes. A backoff
// sleep (the one in retry-backoff.mjs) does not wait: it is recorded as a `sleep` event with its delay, and the clock
// advances by exactly that delay before the retry goes out. Every other timer is the real one.
//
// Usage: node node-wire-capture.mjs <node-tree> --node-commit <sha> --session <session.json> --scenarios <scenarios.json> --out <recording.json> [--keep-random]
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROUTES } from './node-capture.mjs';
import { writeFakeCredentials } from './fake-credentials.mjs';
import { RANDOM, startWireServer } from './wire-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = resolve(process.argv[2]);
const read = (file) => JSON.parse(readFileSync(resolve(file), 'utf8'));
const session = read(arg('--session'));
const doc = read(arg('--scenarios'));
const keepRandom = process.argv.includes('--keep-random');

// The real timers, kept for the recorder's own deadlines and the virtual sleeps; the providers see the wrappers below.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let virtualNow = doc.nowMs;
Date.now = () => virtualNow;
// `ws` binds `randomBytes` when it loads, so loading it first leaves its handshake key (and frame masks) genuinely
// random: that value is observed and replaced (wire-server.mjs RANDOM), not made up. Everything the providers draw
// (request ids) comes from the fixed source below.
await import(pathToFileURL(join(root, 'node_modules/ws/wrapper.mjs')).href);
crypto.randomUUID = () => '00000000-0000-4000-8000-000000000000';
crypto.randomBytes = (size) => Buffer.alloc(size);
os.type = () => session.host.type;
os.release = () => session.host.release;
os.arch = () => session.host.arch;
syncBuiltinESMExports();

const traffic = { sink: [], script: { dials: [], replies: [], http: [] }, unanswered: null };
globalThis.setTimeout = (fn, ms, ...args) => {
  // The caller of `setTimeout` is the second frame of the stack.
  if (!new Error().stack.split('\n')[2]?.includes('retry-backoff.mjs')) return realSetTimeout(fn, ms, ...args);
  traffic.sink.push({ kind: 'sleep', ms });
  virtualNow += ms;
  return setImmediate(fn, ...args);
};
globalThis.clearTimeout = (handle) => (handle?.constructor?.name === 'Immediate' ? clearImmediate(handle) : realClearTimeout(handle));

// The recorder's own abort (a request nothing scripted answers) leaves rejections no provider code awaits; that reason, by
// identity, is the only unhandled rejection tolerated.
const ownAborts = new Set();
process.on('unhandledRejection', (reason) => {
  if (!ownAborts.has(reason)) throw reason;
});

class Deadline extends Error {}
const DEADLINE_MS = 30000;
/** Every await of the recording runs under a deadline that names what was awaited; nothing is retried or polled. */
const within = (what, promise) => {
  let timer;
  const deadline = new Promise((_, reject) => { timer = realSetTimeout(() => reject(new Deadline(`timed out after ${DEADLINE_MS} ms awaiting ${what}`)), DEADLINE_MS); });
  return Promise.race([promise, deadline]).finally(() => realClearTimeout(timer));
};

const server = await within('starting the loopback server', startWireServer({ traffic, keepRandom }));
tls.connect = (options, onSecure) => {
  const socket = net.connect({ host: '127.0.0.1', port: server.port });
  Object.assign(socket, { encrypted: true, authorized: true, alpnProtocol: false, servername: options?.servername, getSession: () => undefined, setSession() {} });
  if (typeof onSecure === 'function') socket.once('secureConnect', onSecure);
  socket.once('connect', () => socket.emit('secureConnect'));
  return socket;
};

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-nodecap-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';
process.env.MIXDOG_CODEX_INSTALLATION_ID = session.installationId;
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
delete process.env.TERM_PROGRAM;
delete process.env.MIXDOG_OAI_TRANSPORT;
const FAKE = 'fake-credential-not-a-secret';
writeFakeCredentials(dataDir, (file, value) => writeFileSync(file, JSON.stringify(value)));
// The catalog Node would hold after it listed the Codex models: one row per model of the scenarios, nothing else known.
writeFileSync(join(dataDir, 'openai-oauth-models.json'), JSON.stringify({ version: 7, fetchedAt: doc.nowMs, models: [{ id: ROUTES[0].model }] }));

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const load = (path) => within(`loading ${path}`, import(pathToFileURL(join(root, path)).href));
const P = 'src/runtime/agent/orchestrator/providers/';
const providerOf = {
  gemini: async () => new (await load(P + 'gemini.mjs')).GeminiProvider({ apiKey: FAKE }),
  'grok-oauth': async () => new (await load(P + 'grok-oauth.mjs')).GrokOAuthProvider({ preconnect: false }),
  'anthropic-oauth': async () => new (await load(P + 'anthropic-oauth.mjs')).AnthropicOAuthProvider({}),
  'openai-oauth': async () => new (await load(P + 'openai-oauth.mjs')).OpenAIOAuthProvider({}),
};
const { seedSessionMessages } = await load('src/runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs');
const { buildRequestSendOptions } = await load('src/runtime/agent/orchestrator/session/manager/ask-turn-loop-options.mjs');
const { _clearWebSocketPoolForTest } = await load(P + 'openai-ws-pool.mjs');

const tools = session.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
if (session.system.length !== 4) throw new Error(`the session document holds ${session.system.length} system texts; Node's session seeds four (base rules, stable context, session marker, environment)`);
const [baseRules, stableSystemContext, sessionMarkerCore, sessionEnvironment] = session.system;
const seeded = seedSessionMessages({ baseRules, stableSystemContext, sessionMarkerCore, sessionEnvironment }, []);
/** The v7 uuid's creation stamp: the turn start Node's `mintUuidV7(startedAt)` carried. */
const stampOf = (uuid) => Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16);

const results = [];
const ENV_NAMES = [...new Set(doc.scenarios.flatMap((s) => Object.keys(s.env || {})))];
let openaiProvider = null;
for (const scenario of doc.scenarios) {
  const route = ROUTES.find((r) => r.provider === scenario.provider);
  const entry = { id: scenario.id, provider: scenario.provider, model: route.model };
  // A scenario's environment is the process environment of its run; nothing else sets these variables.
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, scenario.env || {});
  traffic.sink = [];
  traffic.script = { dials: structuredClone(scenario.dials || []), replies: structuredClone(scenario.ws || []), http: structuredClone(scenario.http || []) };
  const controller = new AbortController();
  traffic.unanswered = (kind) => {
    entry.unanswered = kind;
    const reason = new Error(`the scenario scripts no ${kind} answer`);
    ownAborts.add(reason);
    controller.abort(reason);
  };
  let provider;
  if (scenario.provider === 'openai-oauth') {
    if (scenario.fresh || !openaiProvider) {
      // Closing the previous conversation's sockets is the harness's doing (the pool's test cleanup sends its own close
      // frame): the recorder is paused until every one of them has closed, so nothing of it is in the recording.
      traffic.paused = true;
      _clearWebSocketPoolForTest();
      await within('the close of the previous conversation\'s sockets', Promise.all(server.openSockets().map((conn) => server.closed(conn))));
      traffic.paused = false;
      openaiProvider = await providerOf['openai-oauth']();
    }
    provider = openaiProvider;
  } else {
    provider = await providerOf[scenario.provider]();
  }
  const messages = [...seeded, ...scenario.messages];
  let opts = { signal: controller.signal, sessionId: session.threadId };
  if (scenario.provider === 'openai-oauth') {
    // The send options of a turn as Node's session builds them (ask-turn-loop-options.mjs): the session's own id is
    // not the Codex wire identity, the session's `codexWireSessionId` is.
    const { turnId } = scenario;
    const record = { id: doc.nodeSessionId, provider: 'openai-oauth', model: route.model, promptCacheKey: 'mixdog-codex', codexWireSessionId: session.storedHeader.codexWireSessionId };
    opts = buildRequestSendOptions({ sessionId: doc.nodeSessionId, session: record, turnEffort: undefined, effortConfiguration: undefined, stepAutoEffort: null, codexTurnId: turnId, startedAtMs: stampOf(turnId), signal: controller.signal });
  }
  try {
    await within(`the reply of ${scenario.id}`, provider.send(messages, route.model, tools, opts));
    entry.outcome = 'ok';
  } catch (error) {
    // A deadline is the recorder failing, never a recorded outcome.
    if (error instanceof Deadline) throw error;
    if (!scenario.expectError) throw error;
    entry.outcome = entry.unanswered ? 'unanswered' : 'error';
  }
  if (!scenario.expectError && entry.unanswered) throw new Error(`${scenario.id}: a ${entry.unanswered} request had no scripted answer`);
  if (traffic.script.dials.length || traffic.script.replies.length || traffic.script.http.length) throw new Error(`${scenario.id}: the script was not consumed (${JSON.stringify(traffic.script).slice(0, 200)})`);
  if (scenario.awaitClose) {
    const upgrades = traffic.sink.filter((event) => event.kind === 'ws-upgrade');
    await within(`${scenario.id}: the close of connection ${upgrades.at(-1).conn}`, server.closed(upgrades.at(-1).conn, true));
  }
  entry.traffic = traffic.sink;
  results.push(entry);
}
server.stop();
rmSync(dataDir, { recursive: true, force: true });
// The manifest says what the recording is a function of: the Node commit it was recorded from, the input documents and the
// harness files, and which observed values were replaced.
const fileHash = (file) => sha256(readFileSync(resolve(file)));
const manifest = {
  exact: true,
  nodeCommit: arg('--node-commit'),
  sessionSha256: fileHash(arg('--session')),
  scenariosSha256: fileHash(arg('--scenarios')),
  harness: Object.fromEntries(['node-wire-capture.mjs', 'wire-server.mjs'].map((name) => [name, fileHash(join(here, name))])),
  replaced: keepRandom ? [] : [{ kind: 'ws-upgrade', header: 'Sec-WebSocket-Key', value: RANDOM, why: 'drawn at random per connection (RFC 6455 4.1); wire-random-proof.mjs shows two runs differ in nothing else' }],
};
writeFileSync(resolve(arg('--out')), `${JSON.stringify({ manifest, scenarios: results }, null, 1)}\n`);
console.log(results.map((r) => `${r.id}: ${r.traffic.length} events, ${r.outcome}`).join('\n'));
process.exit(0);
