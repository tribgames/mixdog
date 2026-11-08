// Records what Node does with a provider call that fails before any response byte arrives, end to end through the real
// `OpenAICompatProvider.send` (an unprofiled `custom` provider on the `openai-chat` protocol, the harness's provider) and
// the agent loop's `sendWithRecovery` + `applyRetryAction` retry driver:
//
//   node native/core/fixtures/agent/connect-errors/record.mjs --tree D:\mixdog-build\tmp\real-turn-harness\node-tree
// (a Node tree with its `node_modules`, like the other recorders)
//
// Cases, each against a real socket:
//   refused    a loopback port nobody listens on (ECONNREFUSED)
//   dns        a name that does not resolve (`.invalid`, ENOTFOUND)
//   reset      a server that accepts, reads the request and resets the socket before any header (ECONNRESET)
//   badPort    `127.0.0.1:9`: fetch refuses the port itself ("bad port", no errno), so nothing connects
//   cut        a server that answers 200 with an event stream (one comment, nothing reaches the user) and resets the
//              socket after the headers, every time: repeated post-header cuts, the stream-retry budget across replays
//   cutRole    the same with a first chunk that carries only the assistant role (a model event, nothing shown)
//
// `--only cut` records the two cut cases alone into the existing golden (the port scan of `badPorts` is slow).
// `--only probes` records `probes` alone: what the settings page's two custom-provider probes show for the same
// endpoints (refused, badPort, dns), through the real `discoverCustomProviderModels` and `testCustomProvider` of
// `provider-admin.mjs` with a stub config module: the discovery error view (`discoveryErrorView` + `sanitizeCustomError`,
// a raw `fetch` => "fetch failed"), the connection test that gets as far as discovery (its `phase: 'discovery'` result) and
// the one that sends (a manual model, the SDK => the thrown "Connection error.").
//
// `--only transports` records `transports` alone: for each failure kind (refused, dns, reset, badPort, tls, response and
// connect timeout) what each class of Node call (the SDKs, and the raw `fetch` under each kind of timer) throws; see
// `recordTransports`.
//
// The loop is driven the way `send-phase.mjs` drives it: a `retry_transport` verdict adds one to `transportRetriesUsed`
// and carries `transportRetryMax` into the next call; a thrown error ends the turn. Waits are recorded, not served
// (the timers `sleepWithAbort` arms are armed at 0 ms), and `Math.random` is pinned to 0.5 so every jittered wait is
// its bare step.
//
// `golden/connect_errors.json`: per case, the error's chain as the provider throws it, and per loop lap (one
// `sendWithRecovery` call) the provider-level waits (attempts = waits + 1), the loop's own wait, and the verdict.
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const treeAt = args.indexOf('--tree');
const nodeRoot = resolve(treeAt >= 0 ? args[treeAt + 1] : (process.env.MIXDOG_BENCH_TREE ?? join(here, '..', '..', '..', '..', '..')));
const scratch = mkdtempSync(join(tmpdir(), 'mixdog-connect-golden-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'MIXDOG_DESKTOP_USER_DATA', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = join(scratch, key);
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
for (const name of ['MIXDOG_TRANSPORT_RETRY_BACKOFF_MS', 'MIXDOG_CONNECTION_RETRY_BACKOFF_MS', 'MIXDOG_RECOVERY_RETRY_BACKOFF_MS']) delete process.env[name];
mkdirSync(join(here, 'golden'), { recursive: true });
Math.random = () => 0.5;

// Every wait the retry code arms goes through `retry-backoff.mjs` (`timerSleepWithAbort` for the loop's own wait,
// `_defaultAbortSleep` for the provider's `withRetry`); it is recorded against the code that asked for it and armed at
// 0 ms. The sockets' own timers are left alone.
const waits = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...rest) => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  if (!stack.includes('timerSleepWithAbort') && !stack.includes('_defaultAbortSleep')) return realSetTimeout(callback, ms, ...rest);
  waits.push({ by: stack.includes('scheduleTransportReplay') ? 'loop' : 'provider', ms });
  return realSetTimeout(callback, 0, ...rest);
};

const load = (rel) => import(pathToFileURL(join(nodeRoot, rel)).href);
const orchestrator = 'src/runtime/agent/orchestrator';
const { sendWithRecovery, TRANSPORT_RETRY_MAX } = await load(`${orchestrator}/session/send-with-recovery.mjs`);
const { applyRetryAction } = await load(`${orchestrator}/session/loop/send-phase.mjs`);
const { OpenAICompatProvider } = await load(`${orchestrator}/providers/openai-compat.mjs`);
const { isProviderRecoveryExhausted, isProviderRecoveryTerminal } = await load(`${orchestrator}/providers/retry-executor.mjs`);
const { isConnectFailure } = await load(`${orchestrator}/providers/retry-classification.mjs`);

const admin = await load('src/session-runtime/services/provider-admin.mjs');

const MAX_LAPS = 30;

const chainOf = (error) => {
  const chain = [];
  for (let item = error, depth = 0; item && depth < 6; item = item.cause, depth += 1) {
    chain.push({ name: item.name ?? null, code: item.code ?? null, message: String(item.message ?? '').replace(/127\.0\.0\.1:\d+/, '127.0.0.1:<port>') });
  }
  return chain;
};

async function record(baseURL) {
  const provider = new OpenAICompatProvider('custom-harness', { apiKey: 'fixture', baseURL, preconnect: false });
  const state = { transportRetriesUsed: 0, transportRetryMax: 0 };
  const laps = [];
  let ended = null;
  for (let lap = 0; lap < MAX_LAPS && !ended; lap += 1) {
    waits.length = 0;
    const stages = [];
    const ctx = {
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
      sendTools: [],
      tools: [],
      sessionId: 'connect-errors',
      nextIteration: 1,
      provider,
      opts: { onStageChange: (stage, detail) => stages.push({ stage, detail }) },
      transportRetriesUsed: state.transportRetriesUsed,
      transportRetryMax: state.transportRetryMax,
    };
    const entry = { providerWaitsMs: [], loopWaitMs: null, verdict: null, transportRetryMax: null };
    try {
      const result = await sendWithRecovery(ctx);
      entry.verdict = result.action;
      if (applyRetryAction(state, result)) entry.transportRetryMax = result.transportRetryMax ?? null;
      else ended = { kind: 'result', action: result.action };
    } catch (error) {
      entry.verdict = 'threw';
      // What `providerRecoveryEnded` (`send-with-recovery.mjs:190`) tells apart: a terminal verdict, an exhausted
      // ladder, and a connect failure (which the loop keeps waiting out).
      ended = {
        kind: 'threw',
        message: String(error.message).replace(/127\.0\.0\.1:\d+/, '127.0.0.1:<port>'),
        chain: chainOf(error),
        providerRecoveryExhausted: isProviderRecoveryExhausted(error),
        providerRecoveryTerminal: isProviderRecoveryTerminal(error),
        connectFailure: isConnectFailure(error),
      };
    }
    entry.providerWaitsMs = waits.filter((wait) => wait.by === 'provider').map((wait) => wait.ms);
    const loop = waits.filter((wait) => wait.by === 'loop');
    entry.loopWaitMs = loop.length ? loop[0].ms : null;
    // What the loop's reconnect stage showed for the replay it scheduled.
    const shown = stages.filter((item) => item.stage === 'reconnecting').at(-1);
    entry.shown = entry.verdict === 'retry_transport' && shown
      ? {
          attempt: shown.detail.attempt ?? null,
          max: shown.detail.max ?? shown.detail.maxAttempts ?? null,
          waitingForNetwork: shown.detail.waitingForNetwork === true,
        }
      : null;
    laps.push(entry);
  }
  return { laps, ended: ended ?? { kind: 'capped' } };
}

const portless = (value) => JSON.parse(JSON.stringify(value ?? null).replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>'));
const cfgMod = { loadConfig: () => ({ providers: {} }), saveConfig() {} };

// The same unsaved input through both probes; the connection test once with a manual model (it sends, no discovery) and
// once without (it discovers first and stops at the discovery error).
async function recordProbes(baseURL) {
  const input = { name: 'Probe', protocol: 'openai-chat', baseURL, apiKey: 'sk-DUMMY-probe-secret-0123456789' };
  const manual = { ...input, schemaVersion: 2, modelOverrides: { 'm-manual': { manual: true } } };
  const attempt = async (run) => {
    try {
      return { result: portless(await run()) };
    } catch (error) {
      return { thrown: portless(String(error.message)) };
    }
  };
  return {
    discover: await attempt(() => admin.discoverCustomProviderModels(cfgMod, input)),
    testDiscovery: await attempt(() => admin.testCustomProvider(cfgMod, input)),
    testSend: await attempt(() => admin.testCustomProvider(cfgMod, manual)),
  };
}

const closedPort = () =>
  new Promise((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

const resetServer = () =>
  new Promise((done) => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.once('data', () => socket.resetAndDestroy());
      socket.on('error', () => {});
    }).listen(0, '127.0.0.1', () => done({ server, port: server.address().port, count: () => connections }));
  });

// Answers every request with a 200 event stream and resets the socket 50 ms after the headers.
const cutServer = (first) =>
  new Promise((done) => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.on('error', () => {});
      socket.once('data', () => {
        socket.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\n\r\n${first}`);
        setTimeout(() => socket.resetAndDestroy(), 50);
      });
    }).listen(0, '127.0.0.1', () => done({ server, port: server.address().port, count: () => connections }));
  });

// The ports `fetch` refuses itself, found by asking it for every port of loopback: the refusal is a plain "bad port" at the
// end of the error chain, where a port nobody listens on ends in ECONNREFUSED.
async function badPorts() {
  const found = [];
  let next = 1;
  const worker = async () => {
    while (next <= 65535) {
      const port = next++;
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      } catch (error) {
        let last = error;
        while (last.cause) last = last.cause;
        if (last.message === 'bad port') found.push(port);
      }
    }
  };
  await Promise.all(Array.from({ length: 200 }, worker));
  return found.sort((a, b) => a - b);
}

// --- transports: what each way Node issues a request shows for each way the request can fail ---------------------
// Classes (the Node call site decides which a Rust `Exchange` is; `transport/deadlines.rs`):
//   sdkOpenAI / sdkAnthropic  the pinned SDKs' `chat.completions.create` / `messages.create` on the provider's own client
//   fetchDispatcher           a raw `fetch` with no timer of its own, on the shared undici dispatcher
//   fetchSignal               a raw `fetch` under `AbortSignal.timeout`
//   fetchLabeled              a raw `fetch` under `createTimeoutSignal(…, label)` (`stall-policy.mjs:384`)
//   fetchAborted              a raw `fetch` whose caller aborts a controller on a bare `setTimeout`
// Kinds: refused, dns, reset, badPort, tls (a plain server answering the TLS handshake with HTTP), responseTimeout (the
// server accepts and never answers) and connectTimeout (an address no one answers: 192.0.2.1, TEST-NET-1).
// Every timer is TRANSPORT_TIMEOUT_MS so the recording takes seconds; the undici connector's own 10 s is waited out once.
const TRANSPORT_TIMEOUT_MS = 400;
async function recordTransports() {
  process.env.MIXDOG_LLM_HEADERS_TIMEOUT_MS = String(TRANSPORT_TIMEOUT_MS);
  process.env.MIXDOG_LLM_BODY_TIMEOUT_MS = String(TRANSPORT_TIMEOUT_MS);
  const { getLlmDispatcher } = await load('src/runtime/shared/llm/http-agent.mjs');
  const { createTimeoutSignal } = await load(`${orchestrator}/stall-policy.mjs`);
  const { AnthropicProvider } = await load(`${orchestrator}/providers/anthropic.mjs`);
  const dispatcher = getLlmDispatcher();
  const messages = [{ role: 'user', content: 'hi' }];
  const clients = {
    sdkOpenAI: async (base) => {
      const client = new OpenAICompatProvider('custom-harness', { apiKey: 'fixture', baseURL: base, preconnect: false })._createClient('fixture');
      client.timeout = TRANSPORT_TIMEOUT_MS;
      return client.chat.completions.create({ model: 'm', messages });
    },
    sdkAnthropic: async (base) => {
      const client = new AnthropicProvider({ name: 'custom-harness-a', apiKey: 'fixture', baseURL: base })._createClient('fixture');
      client.timeout = TRANSPORT_TIMEOUT_MS;
      return client.messages.create({ model: 'm', max_tokens: 16, messages });
    },
    fetchDispatcher: (base) => fetch(`${base}/models`, { dispatcher }),
    fetchSignal: (base) => fetch(`${base}/models`, { dispatcher, signal: AbortSignal.timeout(TRANSPORT_TIMEOUT_MS) }),
    fetchLabeled: async (base) => {
      const timer = createTimeoutSignal(null, TRANSPORT_TIMEOUT_MS, 'probe label');
      try {
        return await fetch(`${base}/models`, { dispatcher, signal: timer.signal });
      } finally {
        timer.cleanup();
      }
    },
    fetchAborted: async (base) => {
      const controller = new AbortController();
      const timer = realSetTimeout(() => controller.abort(), TRANSPORT_TIMEOUT_MS);
      try {
        return await fetch(`${base}/models`, { dispatcher, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    },
  };
  const silent = () =>
    new Promise((done) => {
      const server = createServer((socket) => socket.on('error', () => {})).listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
    });
  const plainOnTls = () =>
    new Promise((done) => {
      const server = createServer((socket) => {
        socket.on('error', () => {});
        socket.once('data', () => socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n'));
      }).listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
    });
  const reset = await resetServer();
  const quiet = await silent();
  const tls = await plainOnTls();
  const kinds = {
    refused: `http://127.0.0.1:${await closedPort()}/v1`,
    dns: 'https://connect-errors-no-such-host.invalid/v1',
    reset: `http://127.0.0.1:${reset.port}/v1`,
    badPort: 'http://127.0.0.1:9/v1',
    tls: `https://127.0.0.1:${tls.port}/v1`,
    responseTimeout: `http://127.0.0.1:${quiet.port}/v1`,
    connectTimeout: 'https://192.0.2.1/v1',
  };
  const out = {};
  for (const [kind, base] of Object.entries(kinds)) {
    out[kind] = {};
    for (const [name, run] of Object.entries(clients)) {
      try {
        await run(base);
        out[kind][name] = { resolved: true };
      } catch (error) {
        out[kind][name] = { name: error.name ?? null, message: portless(String(error.message)), chain: chainOf(error) };
      }
    }
  }
  reset.server.close();
  quiet.server.close();
  tls.server.close();
  return { timeoutMs: TRANSPORT_TIMEOUT_MS, kinds: out };
}

const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const goldenFile = join(here, 'golden', 'connect_errors.json');
const golden = only ? JSON.parse(readFileSync(goldenFile, 'utf8')) : { transportRetryMax: TRANSPORT_RETRY_MAX, badPorts: await badPorts(), cases: {} };
if (!only) {
  golden.cases.refused = await record(`http://127.0.0.1:${await closedPort()}/v1`);
  golden.cases.dns = await record('https://connect-errors-no-such-host.invalid/v1');
  const reset = await resetServer();
  golden.cases.reset = await record(`http://127.0.0.1:${reset.port}/v1`);
  golden.cases.reset.connections = reset.count();
  reset.server.close();
  golden.cases.badPort = await record('http://127.0.0.1:9/v1');
}
if (!only || only === 'probes') {
  golden.probes = {
    refused: await recordProbes(`http://127.0.0.1:${await closedPort()}/v1`),
    badPort: await recordProbes('http://127.0.0.1:9/v1'),
    dns: await recordProbes('https://connect-errors-no-such-host.invalid/v1'),
  };
}
if (!only || only === 'transports') golden.transports = await recordTransports();
for (const [name, first] of only === 'probes' || only === 'transports' ? [] : [
  ['cut', ': open\n\n'],
  ['cutRole', `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`],
]) {
  const cut = await cutServer(first);
  golden.cases[name] = await record(`http://127.0.0.1:${cut.port}/v1`);
  golden.cases[name].connections = cut.count();
  cut.server.close();
}

writeFileSync(goldenFile,`${JSON.stringify(golden, null, 2)}\n`);
console.log(
  Object.entries(golden.cases)
    .map(([name, item]) => `${name}: ${item.laps.length} laps, ends ${item.ended.kind}`)
    .join('\n')
);
process.exit(0);
