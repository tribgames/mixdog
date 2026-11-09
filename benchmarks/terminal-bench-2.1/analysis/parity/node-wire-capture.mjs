#!/usr/bin/env node
// Node half of the wire parity check: the real provider classes of Node (b6f10295a), one send per scenario, with the
// transport replaced by recorders at its boundary. Every byte handed to the transport is recorded: for `fetch` the url,
// the headers (credentials and the content-encoding the provider added at send time included) and the body as sent
// (its length, sha256 and its decoded text); for the Codex WebSocket the handshake url and headers and every frame text.
// Time, randomness and the host identity are fixed by the session document, and timers never fire (ws-recorder.mjs), so
// the recording is a function of the inputs: the Node tree, the session document and the scenario document.
//
// Usage: node node-wire-capture.mjs <node-tree> --node-commit <sha> --session <session.json> --scenarios <scenarios.json> --out <recording.json>
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { register, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { ROUTES } from './node-capture.mjs';
import { writeFakeCredentials } from './fake-credentials.mjs';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = resolve(process.argv[2]);
const read = (file) => JSON.parse(readFileSync(resolve(file), 'utf8'));
const session = read(arg('--session'));
const doc = read(arg('--scenarios'));

// Fixed inputs: the clock, the random bytes, the host the User-Agent describes.
Date.now = () => doc.nowMs;
crypto.randomBytes = (size) => Buffer.alloc(size);
crypto.randomUUID = () => '00000000-0000-4000-8000-000000000000';
os.type = () => session.host.type;
os.release = () => session.host.release;
os.arch = () => session.host.arch;
syncBuiltinESMExports();
// A timer is registered and never fires: a scripted exchange finishes through events alone, so a send that waits on
// one (a retry sleep, a watchdog) ends the process with an unsettled await instead of sleeping.
const handle = () => ({ ref() { return this; }, unref() { return this; }, hasRef: () => false, refresh() { return this; }, [Symbol.toPrimitive]: () => 0 });
globalThis.setTimeout = handle;
globalThis.setInterval = handle;
globalThis.clearTimeout = () => {};
globalThis.clearInterval = () => {};

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

// Anything that reaches for the network fails loudly: the global dispatcher is not an undici Agent, so the providers'
// preconnect is a no-op, and a request through it throws.
globalThis[Symbol.for('undici.globalDispatcher.1')] = new (class NoNetwork { dispatch() { throw new Error('the recorder allows no network'); } close() {} destroy() {} })();

const hooks = pathToFileURL(fileURLToPath(new URL('./ws-hooks.mjs', import.meta.url)));
const recorderUrl = new URL('./ws-recorder.mjs', import.meta.url).href;
register(hooks, { data: { target: recorderUrl } });
const { traffic } = await import(recorderUrl);

class Stop extends Error {}
const headerPairs = (headers) => {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.entries()];
  return Array.isArray(headers) ? headers : Object.entries(headers);
};
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sentBody = (body, headers) => {
  if (body == null) return null;
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
  const encoding = new Headers(headers || {}).get('content-encoding');
  const decoded = encoding === 'gzip' ? gunzipSync(bytes) : encoding === 'zstd' ? zstdDecompressSync(bytes) : bytes;
  return { encoding, bytes: bytes.length, sha256: sha256(bytes), text: decoded.toString('utf8') };
};
const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
globalThis.fetch = async (url, init = {}) => {
  traffic.sink.push({ kind: 'http', method: init.method || 'GET', url: String(url), headers: headerPairs(init.headers), body: sentBody(init.body, init.headers) });
  const reply = traffic.script.http.shift();
  if (!reply) throw new Stop('the recorder serves no response');
  return new Response(sse(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const load = (path) => import(pathToFileURL(join(root, path)).href);
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
let openaiProvider = null;
for (const scenario of doc.scenarios) {
  const route = ROUTES.find((r) => r.provider === scenario.provider);
  const entry = { id: scenario.id, provider: scenario.provider, model: route.model };
  traffic.sink = [];
  traffic.script = { dials: structuredClone(scenario.dials || []), replies: structuredClone(scenario.ws || []), http: structuredClone(scenario.http || []) };
  try {
    let provider;
    if (scenario.provider === 'openai-oauth') {
      if (scenario.fresh || !openaiProvider) {
        _clearWebSocketPoolForTest();
        openaiProvider = await providerOf['openai-oauth']();
      }
      provider = openaiProvider;
    } else {
      provider = await providerOf[scenario.provider]();
    }
    const messages = [...seeded, ...scenario.messages];
    const signal = new AbortController().signal;
    let opts = { signal, sessionId: session.threadId };
    if (scenario.provider === 'openai-oauth') {
      // The send options of a turn as Node's session builds them (ask-turn-loop-options.mjs): the session's own id is
      // not the Codex wire identity, the session's `codexWireSessionId` is.
      const { turnId } = scenario;
      const record = { id: doc.nodeSessionId, provider: 'openai-oauth', model: route.model, promptCacheKey: 'mixdog-codex', codexWireSessionId: session.threadId };
      opts = buildRequestSendOptions({ sessionId: doc.nodeSessionId, session: record, turnEffort: undefined, effortConfiguration: undefined, stepAutoEffort: null, codexTurnId: turnId, startedAtMs: stampOf(turnId), signal });
    }
    await provider.send(messages, route.model, tools, opts);
  } catch (error) {
    if (!scenario.expectError) throw error;
    entry.error = String(error?.message || error).slice(0, 200);
  }
  if (traffic.script.dials.length || traffic.script.replies.length || traffic.script.http.length) throw new Error(`${scenario.id}: the script was not consumed (${JSON.stringify(traffic.script).slice(0, 200)})`);
  entry.traffic = traffic.sink;
  results.push(entry);
}
rmSync(dataDir, { recursive: true, force: true });
// The manifest says what the recording is a function of: the Node commit it was recorded from and the two input documents.
const manifest = { exact: true, nodeCommit: arg('--node-commit'), sessionSha256: sha256(readFileSync(resolve(arg('--session')))), scenariosSha256: sha256(readFileSync(resolve(arg('--scenarios')))) };
writeFileSync(resolve(arg('--out')), `${JSON.stringify({ manifest, scenarios: results }, null, 1)}\n`);
console.log(results.map((r) => `${r.id}: ${r.traffic.length} records${r.error ? ` (send failed: ${r.error})` : ''}`).join('\n'));
process.exit(0);




