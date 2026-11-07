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
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = join(scratch, key);
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
for (const [name, first] of [
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
