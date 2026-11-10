#!/usr/bin/env node
// Node half of the wire parity check: the real provider classes of Node (b6f10295a) and the real clients under them
// (undici's `fetch`, the `ws` package) send each scenario to a loopback server (wire-server.mjs) that records the bytes it
// receives. The only substitution is the connection: `tls.connect` hands the client a plain socket to the loopback server,
// so the clients write what they would write inside TLS to the real host (url, `Host`, headers, upgrade request, frames).
//
// Inputs that are fixed, not observed: the clock (`Date.now`), `randomUUID` (a sequence that starts over with each
// scenario: its 1st id, its 2nd id, ..., so the recording shows which draw each use is), `Math.random` (0.5: a jittered
// backoff is its step exactly), the host the User-Agent describes. A backoff sleep (the one in retry-backoff.mjs, the
// WebSocket send's own, `openai-ws-send-attempts/policy.mjs` `_defaultSleep`, and the Grok token refresh's,
// `grok-oauth-tokens.mjs` `_postRefreshWithRetry`) does not wait: it is recorded as a `sleep` event with its delay, and
// the clock advances by exactly that delay before the retry goes out. Every other timer is the real one.
//
// Run it under the runtime the product runs its core under: the desktop's Electron in node mode
// (`ELECTRON_RUN_AS_NODE=1 electron node-wire-capture.mjs ...`); the manifest names the runtime and the client versions.
// Usage: node node-wire-capture.mjs <node-tree> --node-commit <sha> --session <session.json> --scenarios <scenarios.json> --out <recording.json> [--keep-random] [--only <scenario id>]
// `--only` records one scenario with the ones of its conversation before it (from the last `fresh` one), which it
// continues; the manifest names it, and only a whole recording is the committed fixture.
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
const only = process.argv.includes('--only') ? arg('--only') : null;
/** The scenarios a run records: all, or the one `--only` names with the ones of its conversation before it. */
function selected(scenarios) {
  if (!only) return scenarios;
  const at = scenarios.findIndex((s) => s.id === only);
  if (at < 0) throw new Error(`no scenario ${only}`);
  // Another provider's scenario stands alone, or (`continues`) runs after the ones before it, whose process state (and,
  // `sameProvider`, whose provider) it reads.
  if (scenarios[at].provider !== 'openai-oauth') {
    let start = at;
    while (start > 0 && scenarios[start].continues) start -= 1;
    return scenarios.slice(start, at + 1);
  }
  let start = at;
  while (start > 0 && !scenarios[start].fresh && scenarios[start - 1].provider === 'openai-oauth') start -= 1;
  return scenarios.slice(start, at + 1);
}

// The real timers, kept for the recorder's own deadlines and the virtual sleeps; the providers see the wrappers below.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let virtualNow = doc.nowMs;
Date.now = () => virtualNow;
// `ws` binds `randomBytes` when it loads, so loading it first leaves its handshake key (and frame masks) genuinely
// random: that value is observed and replaced (wire-server.mjs RANDOM), not made up. Everything the providers draw
// (request ids) comes from the fixed source below.
await import(pathToFileURL(join(root, 'node_modules/ws/wrapper.mjs')).href);
let uuidDraws = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidDraws).padStart(12, '0')}`;
Math.random = () => 0.5;
crypto.randomBytes = (size) => Buffer.alloc(size);
os.type = () => session.host.type;
os.release = () => session.host.release;
os.arch = () => session.host.arch;
syncBuiltinESMExports();

const traffic = { sink: [], script: { dials: [], replies: [], http: [] }, unanswered: null };
globalThis.setTimeout = (fn, ms, ...args) => {
  // The caller of `setTimeout` is the second frame of the stack.
  const caller = new Error().stack.split('\n')[2] ?? '';
  if (!['retry-backoff.mjs', 'openai-ws-send-attempts', 'grok-oauth-tokens.mjs'].some((file) => caller.includes(file))) return realSetTimeout(fn, ms, ...args);
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
// A scenario that names its own model has that row offer the `priority` service tier (`modelSupportsServiceTier`).
const tierModels = [...new Set(doc.scenarios.filter((s) => s.provider === 'openai-oauth' && s.model).map((s) => s.model))];
const rows = [{ id: ROUTES[0].model }, ...tierModels.map((id) => ({ id, serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }] }))];
writeFileSync(join(dataDir, 'openai-oauth-models.json'), JSON.stringify({ version: 7, fetchedAt: doc.nowMs, models: rows }));

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const load = (path) => within(`loading ${path}`, import(pathToFileURL(join(root, path)).href));
const P = 'src/runtime/agent/orchestrator/providers/';
const providerOf = {
  gemini: async () => new (await load(P + 'gemini.mjs')).GeminiProvider({ apiKey: FAKE }),
  // As the product registers it (`registry.mjs` `_registerLazyOAuthProvider`: `new Ctor({})`), so its socket warm-up
  // (`preconnect`, a HEAD to the proxy) is part of the recording.
  'grok-oauth': async () => new (await load(P + 'grok-oauth.mjs')).GrokOAuthProvider({}),
  'anthropic-oauth': async () => new (await load(P + 'anthropic-oauth.mjs')).AnthropicOAuthProvider({}),
  'openai-oauth': async () => new (await load(P + 'openai-oauth.mjs')).OpenAIOAuthProvider({}),
};
const { seedSessionMessages } = await load('src/runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs');
const { buildRequestSendOptions } = await load('src/runtime/agent/orchestrator/session/manager/ask-turn-loop-options.mjs');
const { buildSessionRecord, sessionOriginFields } = await load('src/runtime/agent/orchestrator/session/manager/session-record.mjs');
const { _clearWebSocketPoolForTest } = await load(P + 'openai-ws-pool.mjs');
const { captureSideQuestionRequest } = await load('src/runtime/agent/orchestrator/session/side-question-store.mjs');
const { summarizeOnSharedPrefix } = await load('src/runtime/agent/orchestrator/session/compact/forked-summary.mjs');
const { disposeTransportScope } = await load(P + 'transport-scope.mjs');
const { providerCacheKey } = await load('src/runtime/agent/orchestrator/session/manager/provider-cache-key.mjs');

const tools = session.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
if (session.system.length !== 4) throw new Error(`the session document holds ${session.system.length} system texts; Node's session seeds four (base rules, stable context, session marker, environment)`);
const [baseRules, stableSystemContext, sessionMarkerCore, sessionEnvironment] = session.system;
const seeded = seedSessionMessages({ baseRules, stableSystemContext, sessionMarkerCore, sessionEnvironment }, []);
/** The v7 uuid's creation stamp: the turn start Node's `mintUuidV7(startedAt)` carried. */
const stampOf = (uuid) => Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16);

const results = [];
const ENV_NAMES = [...new Set(doc.scenarios.flatMap((s) => Object.keys(s.env || {})))];
let openaiProvider = null;
let grokProvider = null;
/** The latest send of the run and its reply: what a compaction scenario forks. */
let lastSend = null;
for (const scenario of selected(doc.scenarios)) {
  const route = { ...ROUTES.find((r) => r.provider === scenario.provider) };
  if (scenario.model) route.model = scenario.model;
  const entry = { id: scenario.id, provider: scenario.provider, model: route.model };
  // A scenario's environment is the process environment of its run; nothing else sets these variables.
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, scenario.env || {});
  traffic.sink = [];
  uuidDraws = 0;
  traffic.script = { dials: structuredClone(scenario.dials || []), replies: structuredClone(scenario.ws || []), http: structuredClone(scenario.http || []) };
  const controller = new AbortController();
  // `abortWhenHeld`: the turn is cancelled (the session's abort signal) once the server has written a held reply.
  traffic.held = scenario.abortWhenHeld
    ? () => {
        const reason = new Error('the turn was cancelled');
        ownAborts.add(reason);
        controller.abort(reason);
      }
    : null;
  traffic.unanswered = (kind) => {
    entry.unanswered = kind;
    const reason = new Error(`the scenario scripts no ${kind} answer`);
    ownAborts.add(reason);
    controller.abort(reason);
  };
  // A Grok turn starts once the previous turn's connections are back in the pool, as the turns of a session are (between
  // two there is always I/O: tools, the user): undici returns a socket one event-loop turn after its response ended
  // (`client-h1.js` onMessageComplete, `setImmediate(client[kResume])`).
  if (scenario.provider === 'grok-oauth') await within(`the event-loop turn before ${scenario.id}`, new Promise((resolve) => setImmediate(resolve)));
  // `credentials`: the credential files of the scenario's account (an expiring token, a stored token endpoint or none, a
  // user id), written before its provider loads them. An expiry `{ fromNow }` is that many ms after the recording's clock
  // at the scenario's start, which earlier scenarios' backoffs have moved on.
  for (const [file, value] of Object.entries(scenario.credentials || {})) {
    const expiresAt = value.expires_at?.fromNow;
    writeFileSync(join(dataDir, file), JSON.stringify(expiresAt === undefined ? value : { ...value, expires_at: virtualNow + expiresAt }));
  }
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
  } else if (scenario.provider === 'grok-oauth') {
    // `sameProvider`: the turn of the process's Grok provider the previous scenario sent with (its grace window, its
    // tokens), as the product holds one provider per process; otherwise a provider loaded anew.
    if (!scenario.sameProvider || !grokProvider) grokProvider = await providerOf['grok-oauth']();
    provider = grokProvider;
  } else {
    provider = await providerOf[scenario.provider]();
  }
  const messages = [...seeded, ...scenario.messages];
  let opts = { signal: controller.signal, sessionId: session.threadId };
  if (scenario.provider === 'openai-oauth') {
    // The send options of a turn as Node's session builds them (ask-turn-loop-options.mjs): the session's own id is
    // not the Codex wire identity, the session's `codexWireSessionId` is.
    // `sendOpts` are the turn's effort and the session's fast flag, the two inputs of the effort and service-tier
    // scenarios; a scenario without them sends as the first turn does.
    const { turnId, sendOpts = {}, identity = {} } = scenario;
    let sessionId = doc.nodeSessionId;
    let record = { id: sessionId, provider: 'openai-oauth', model: route.model, promptCacheKey: 'mixdog-codex', codexWireSessionId: identity.stored ?? session.storedHeader.codexWireSessionId, ...(sendOpts.fast === true ? { fast: true } : {}) };
    if (identity.subAgent) {
      // A sub-agent's session as Node creates it (`buildSessionRecord`, session-record.mjs): its own record, with the wire
      // identity minted for it at creation, under the parent that delegated it. The clock reads the recording's instant
      // while the record is built, so the identity it mints is fixed.
      sessionId = identity.subAgent.sessionId;
      const opts2 = { provider: 'openai-oauth', owner: 'agent', agent: identity.subAgent.agent, parentSessionId: doc.nodeSessionId, ownerSessionId: doc.nodeSessionId, cwd: dataDir };
      const realNow = Date.now;
      Date.now = () => doc.nowMs;
      try {
        const origin = sessionOriginFields(opts2, { profile: null, presetObj: null, providerCacheOpts: null, surface: { toolPermission: null, hasCallerAllow: false } });
        const routeOf = { providerName: 'openai-oauth', modelName: route.model, toolPreset: null, effort: null, fast: false, autoEffort: undefined, modelParameters: {}, contextPercent: null, contextTokens: null, id: sessionId };
        record = buildSessionRecord({ opts: opts2, route: routeOf, presetObj: null, surface: { tools: [], toolSpec: null, sessionDeny: [] }, prompt: {}, messages: [], contextMeta: {}, origin });
      } finally {
        Date.now = realNow;
      }
      entry.storedHeader = { codexWireSessionId: record.codexWireSessionId, promptCacheKey: record.promptCacheKey, owner: record.owner, parentSessionId: record.parentSessionId };
    }
    // The record as a resumed session has it: through the store's JSON (`saveSession`, `loadSession`).
    record = JSON.parse(JSON.stringify(record));
    opts = buildRequestSendOptions({ sessionId, session: record, turnEffort: sendOpts.effort, effortConfiguration: undefined, stepAutoEffort: null, codexTurnId: turnId, startedAtMs: stampOf(turnId), signal: controller.signal });
  } else if (scenario.provider === 'grok-oauth') {
    // The send options of a Grok turn as Node's loop hands them to the provider: the session's request options
    // (`buildRequestSendOptions`, its cache key the one a session of the provider is created with, `providerCacheKey`),
    // the loop's iteration (`send-phase.mjs:100`) and the admission owner (`send-with-recovery.mjs:263`). `sendOpts`
    // are the turn's effort and iteration.
    const { sendOpts = {} } = scenario;
    const record = { id: session.threadId, provider: 'grok-oauth', model: route.model, promptCacheKey: providerCacheKey('grok-oauth') };
    opts = {
      ...buildRequestSendOptions({ sessionId: session.threadId, session: record, turnEffort: sendOpts.effort, effortConfiguration: undefined, stepAutoEffort: null, codexTurnId: undefined, startedAtMs: undefined, signal: controller.signal }),
      iteration: sendOpts.iteration,
      admissionOwner: session.threadId,
    };
  }
  if (scenario.disposeWhenHeld) {
    // `disposeWhenHeld`: the send's transport scope is disposed (`disposeTransportScope`, transport-scope.mjs) once the
    // server has written a held reply, while the response is still running.
    const scope = opts.transportScope || opts.sessionId;
    traffic.held = () => disposeTransportScope(scope, provider);
  }
  try {
    if (scenario.compaction) {
      // The compaction summary as Node's compaction sends it (`summarizeOnSharedPrefix`, forked-summary.mjs): a fork of the
      // session's latest request, which the loop keeps with its reply (`captureSideQuestionRequest`), here the previous
      // scenario's send.
      if (!lastSend) throw new Error(`${scenario.id}: no send before the compaction to fork`);
      captureSideQuestionRequest({ sessionId: doc.nodeSessionId, sessionRef: {}, provider, model: route.model, messages: lastSend.messages, tools, opts: lastSend.opts }).settle(lastSend.response);
      const route2 = { provider, providerName: scenario.provider, model: route.model, contextWindow: 1_000_000 };
      const summary = await within(`the reply of ${scenario.id}`, summarizeOnSharedPrefix({ sessionId: doc.nodeSessionId, route: route2, conversationInput: [], signal: controller.signal }));
      if (summary.fallback) throw summary.error ?? new Error(`${scenario.id}: the fork fell back (${summary.fallback})`);
    } else {
      const response = await within(`the reply of ${scenario.id}`, provider.send(messages, route.model, tools, opts));
      lastSend = { messages, opts, response };
    }
    entry.outcome = 'ok';
  } catch (error) {
    // A deadline is the recorder failing, never a recorded outcome.
    if (error instanceof Deadline) throw error;
    if (!scenario.expectError) throw error;
    entry.outcome = entry.unanswered ? 'unanswered' : 'error';  }
  if (!scenario.expectError && entry.unanswered) throw new Error(`${scenario.id}: a ${entry.unanswered} request had no scripted answer`);
  if (traffic.script.dials.length || traffic.script.replies.length || traffic.script.http.length) throw new Error(`${scenario.id}: the script was not consumed (${JSON.stringify(traffic.script).slice(0, 200)})`);
  if (scenario.awaitClose === 'first') {
    // The scenario's first socket, muted, records its own end: the scenario lasts until it ended.
    const first = traffic.sink.find((event) => event.kind === 'ws-upgrade');
    await within(`${scenario.id}: the close of connection ${first.conn}`, server.closed(first.conn, false));
  } else if (scenario.awaitClose) {
    const upgrades = traffic.sink.filter((event) => event.kind === 'ws-upgrade');
    await within(`${scenario.id}: the close of connection ${upgrades.at(-1).conn}`, server.closed(upgrades.at(-1).conn, true));
  }
  entry.traffic = traffic.sink;
  results.push(entry);
}
server.stop();
// The manifest says what the recording is a function of: the Node commit it was recorded from, the input documents and the
// harness files, and which observed values were replaced.
const fileHash = (file) => sha256(readFileSync(resolve(file)));
// The text `scenarios` has in the written document (one more space of indent per line), hashed into the manifest.
const recorded = JSON.stringify(results, null, 1).replaceAll('\n', '\n ');
const manifest = {
  exact: true,
  nodeCommit: arg('--node-commit'),
  // The runtime the recording ran under (the desktop's Electron in node mode) and the clients it loaded from the tree.
  runtime: { electron: process.versions.electron ?? null, node: process.version, bundledUndici: process.versions.undici },
  clients: Object.fromEntries(['undici', 'ws'].map((name) => [name, read(join(root, 'node_modules', name, 'package.json')).version])),
  sessionSha256: fileHash(arg('--session')),
  scenariosSha256: fileHash(arg('--scenarios')),
  harness: Object.fromEntries(['node-wire-capture.mjs', 'wire-server.mjs'].map((name) => [name, fileHash(join(here, name))])),
  replaced: keepRandom ? [] : [{ kind: 'ws-upgrade', header: 'Sec-WebSocket-Key', value: RANDOM, why: 'drawn at random per connection (RFC 6455 4.1); wire-random-proof.mjs shows two runs differ in nothing else' }],
  scenariosRecordedSha256: sha256(recorded),
  ...(only ? { only } : {}),
};
const written = `${JSON.stringify({ manifest, scenarios: results }, null, 1)}\n`;
if (!written.endsWith(`\n "scenarios": ${recorded}\n}\n`)) throw new Error('the written scenarios are not the hashed text');
writeFileSync(resolve(arg('--out')), written);
console.log(results.map((r) => `${r.id}: ${r.traffic.length} events, ${r.outcome}`).join('\n'));
// Written before anything is awaited again, so what a send left running records nothing after the loop. The product's
// trace spool appends to the data directory asynchronously; drained before the directory is removed.
const { drainAgentTrace } = await load('src/runtime/agent/orchestrator/agent-trace-io.mjs');
await within('the drain of the agent trace', drainAgentTrace());
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
