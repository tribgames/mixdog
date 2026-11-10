#!/usr/bin/env node
// A built mixdogd driven for real against Node's recording (`native/core/fixtures/call-tool/golden.json`): a scripted OpenAI-chat
// endpoint is the model (so the session is a bridge session) and plays a recorded scenario's script. It FAILS (exit 1) unless what a
// client of the core can observe equals the recording, exactly: what the model was sent (every message but the system prompt; see
// LEFT_OUT), the turn's answer, the approval cards, and the turn's completion. Every wait is on an event (the discovery file appearing,
// a thread notification, the core's exit, an answer) under one deadline that names what did not happen.
//   node benchmarks/rust-core/recorders/replay-call-tool-live.mjs <mixdogd.exe> [--only <scenario name fragment>]
// It runs the recording's `live` scenarios: the ones that call a tool a built core has (the product's `goal`); the other scenarios
// call the recorder's probe tools, which exist only in Node's recorder and the in-process replay (`bridge_calls.rs`).
// Each run has a world folder of its own under one folder (`call-tool-live`) that a run empties first: a world a failed run could not
// remove stays there until then, and the failure names it. The core is ended through its own stop (`mixdogd ctl stop --when-idle`),
// awaited on its exit; a cluster still running for the world is stopped by `pg_ctl stop -m fast -D`; a process still naming the world
// is not killed: the run fails naming it.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, REPO_ROOT } from './lib/common.mjs';
import { endSandbox } from './sandbox-janitor.mjs';

const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const exe = process.argv[2];
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt < 0 ? null : process.argv[onlyAt + 1];
const golden = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'call-tool', 'golden.json'), 'utf8'));
const scenarios = golden.scenarios.filter((s) => s.live && (!only || s.name.includes(only)));
if (!exe || !scenarios.length) {
  console.error('usage: replay-call-tool-live.mjs <mixdogd.exe> [--only <name fragment of a live scenario>]');
  process.exit(2);
}
// What of the recording a client of the core cannot observe, or observes elsewhere:
//   - the system messages of a request: the prompt the host assembles from its own profile, which is not the recorder's session
//     (the in-process replay feeds the recorded prompt to the loop and compares that it is passed on untouched);
//   - `createdAt`, `toolKind`, `toolTiming`, `cacheTier` of a request message: the wire the model sees has none of them;
//   - the stored rows, events, callbacks, hooks, timeline, audit and trace: in-process (`bridge_calls.rs` `NOT_COMPARED`).
const LEFT_OUT = 'system messages; createdAt, toolKind, toolTiming, cacheTier';

const ROOT = join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'call-tool-live');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// One deadline per awaited thing, and a message naming it.
const withDeadline = (promise, label, ms) => {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: not done after ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
};

// A model message as Node's request shows it (`requests[][]`), from the OpenAI-chat message the core sent.
const asRecorded = (m) => ({
  role: m.role,
  content: m.content ?? '',
  ...(m.tool_calls?.length ? { toolCalls: m.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments) })) } : {}),
  ...(m.tool_call_id ? { toolCallId: m.tool_call_id } : {}),
});
const recordedRequest = (messages) =>
  messages.filter((m) => m.role !== 'system').map(({ role, content, toolCalls, toolCallId }) => ({ role, content, ...(toolCalls ? { toolCalls } : {}), ...(toolCallId ? { toolCallId } : {}) }));

const allFailures = [];
for (const scenario of scenarios) {
  const failures = await runScenario(scenario);
  for (const failure of failures) console.error(`FAIL ${scenario.name}: ${failure}`);
  allFailures.push(...failures);
}
if (!allFailures.length) rmSync(ROOT, { recursive: true, force: true });
process.exit(allFailures.length ? 1 : 0);

async function runScenario(recorded) {
const scenario = { script: recorded.script };
const world = mkdtempSync(join(ROOT, 'world-'));
const dataDir = join(world, 'data');
let server = null;
let child = null;
let spawnError = null;
let client = null;
let stderr = '';
let seen = '';
const hits = [];
const failures = [];

// Resolves with the first non-null `probe()`, tried now and again on every event `subscribe` reports; rejects naming `label` at the deadline.
const waitOn = (label, ms, subscribe, probe) =>
  new Promise((resolve, reject) => {
    let done = false;
    let stop = () => {};
    const timer = setTimeout(() => finish(reject, new Error(`${label}: not done after ${ms} ms`)), ms);
    const finish = (settle, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      settle(value);
    };
    const attempt = async () => {
      try {
        const value = await probe();
        if (value) finish(resolve, value);
      } catch (error) {
        finish(reject, error);
      }
    };
    stop = subscribe(attempt);
    void attempt();
  });

// Ends everything this run started, by ownership: the client it holds, the core through its own stop, the scripted model it listens
// with. Returns the failures.
async function endWorld() {
  const ended = [];
  try {
    if (client) await withDeadline(client.close(), 'closing the protocol client', 30_000);
  } catch (error) {
    ended.push(`closing the client: ${error.message}`);
  }
  if (child && !spawnError && child.exitCode === null) {
    const stop = spawnSync(exe, ['ctl', 'stop', '--when-idle', '--reason', 'quit'], { env: coreEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (stop.error || stop.status !== 0) ended.push(`mixdogd ctl stop answered ${stop.error?.message ?? stop.status}: ${stop.stderr}`);
    try {
      await waitOn('mixdogd exiting after its stop', 60_000, (attempt) => (child.once('exit', attempt), () => child.off('exit', attempt)), async () => child.exitCode !== null || child.signalCode !== null);
    } catch (error) {
      ended.push(error.message);
    }
  }
  if (server) {
    // A keep-alive connection the core left open would hold `close` until it idles out: they are ended first.
    server.closeAllConnections();
    try {
      await withDeadline(new Promise((resolve) => server.close(resolve)), 'closing the scripted model endpoint', 30_000);
    } catch (error) {
      ended.push(error.message);
    }
  }
  ended.push(...endSandbox(world, 0, dataDir));
  return ended;
}

let coreEnv = null;
const cards = [];
try {
  // ---- the scripted model ----
  const requests = [];
  let step = 0;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hits.push(req.method + ' ' + req.url);
      const path = req.url.replace(/^\/v1/, '');
      if (path === '/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm-a' }] }));
      requests.push(JSON.parse(body || '{}'));
      const next = scenario.script[Math.min(step++, scenario.script.length - 1)];
      const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'c', model: 'm-a', choices: [{ index: 0, delta, finish_reason: finish }], usage: finish ? { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } : null })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (next.text !== undefined) return void res.end(chunk({ role: 'assistant', content: next.text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      const tool_calls = next.calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
      res.end(chunk({ role: 'assistant', tool_calls }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;

  // ---- the core ----
  for (const dir of ['runtime', 'data', 'home', 'config', 'project']) mkdirSync(join(world, dir), { recursive: true });
  coreEnv = { ...process.env };
  for (const key of Object.keys(coreEnv)) if (key.startsWith('MIXDOG_')) delete coreEnv[key];
  Object.assign(coreEnv, { MIXDOG_RUNTIME_ROOT: join(world, 'runtime'), MIXDOG_DATA_DIR: dataDir, MIXDOG_HOME: join(world, 'home'), MIXDOG_CONFIG_DIR: join(world, 'config') });
  const manifest = join(exe, '..', 'js-runtime.json');
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
  const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
  child = spawn(exe, ['serve'], { env: coreEnv, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  // A spawn that fails reports it here, asynchronously: it ends the waits below (the child counts as exited) and is the run's failure.
  child.once('error', (error) => {
    spawnError = error;
    child.emit('exit', null, null);
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const file = join(world, 'runtime', 'daemon.json');
  const endpoint = await waitOn(
    'mixdogd publishing its discovery file',
    60_000,
    (attempt) => {
      const watcher = watch(join(world, 'runtime'), attempt);
      child.once('exit', attempt);
      return () => (watcher.close(), child.off('exit', attempt));
    },
    async () => {
      if (spawnError) throw new Error(`mixdogd could not be started: ${spawnError.message}`);
      if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}:\n${stderr}`);
      try {
        return parseDiscovery(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    }
  );
  const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
  const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
  // Every notification of a thread this client watches passes the reducer, in feed order: the run's own events are seen there.
  const threadNotes = [];
  let noted = () => {};
  client = await connect({
    target: { id: 'core' },
    connector: createWsConnector(async () => endpoint),
    clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
    capabilities: { optOutNotificationMethods: [], experimentalApi: false },
    threadReducer: {
      ...sessionReducer,
      apply(state, notification) {
        threadNotes.push(notification);
        noted();
        return sessionReducer.apply(state, notification);
      },
    },
    clock: { sleep: () => Promise.reject(new Error('dropped')) },
    random: Math.random,
  });
  // A call that never answers is the deadline's, not a hang.
  const rpc = (method, params) => {
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method}: no answer after 30000 ms`)), 30_000);
    });
    return Promise.race([client.call(method, params), expired]).finally(() => clearTimeout(timer));
  };
  // An approval card the core asks for: kept (the recording's `cards`) and answered as the recording's answers say, in order.
  const answers = [...recorded.answers];
  client.on((event) => {
    if (event.type !== 'serverRequest') return;
    cards.push(event.request);
    const answer = answers.shift() ?? { approved: false, reason: 'no answer recorded' };
    client.respond(event.request.id, { result: { decision: answer.approved ? 'approve' : 'deny', approved: answer.approved, ...(answer.reason ? { reason: answer.reason } : {}) } });
  });
  const saved = await rpc('account/saveCustomProvider', { input: { name: 'scripted', protocol: 'openai-chat', baseURL, apiKey: 'sk-x' } });
  const provider = saved?.id ?? saved?.provider?.id ?? saved?.providerId;
  const started = await rpc('thread/start', {
    kind: 'task',
    projectPath: join(world, 'project'),
    draft: { projectPath: join(world, 'project'), route: { provider, model: 'm-a' } },
  });
  const threadId = started.thread.id;
  // A client sees a thread's run once it watches the thread, as the desktop does for the threads it shows (`setVisibleSessions` ->
  // `thread/resume`, apps/desktop/src/main/protocol/service-route.ts); Node's desktop service likewise sends a session's state only
  // for a visible session (b6f10295a apps/desktop/src/main/desktop-service-state-sync.ts:191). The thread is watched before its turn starts.
  await withDeadline(client.resumeThread(threadId, { lastItems: 10 }), 'thread/resume', 30_000);
  await rpc('turn/start', { threadId, input: { prompt: 'go', options: {} } });
  // Done when the core says the turn completed (`turn/completed` on the thread's feed).
  const completed = await waitOn(
    'the turn completing (turn/completed)',
    60_000,
    (attempt) => ((noted = attempt), () => (noted = () => {})),
    async () => {
      seen = `model steps taken ${step}/${scenario.script.length}; thread notifications ${threadNotes.map((n) => n.method).join(', ')}`;
      return threadNotes.find((n) => n.method === 'turn/completed' && n.params?.threadId === threadId) ?? null;
    }
  );
  // ---- what the model was sent, request by request, whole but for LEFT_OUT ----
  const sent = requests.map((request) => recordedRequest(request.messages.map(asRecorded)));
  const want = recorded.requests.map(recordedRequest);
  if (!isDeepStrictEqual(sent, want)) failures.push(`what the model was sent differs from the recording (left out: ${LEFT_OUT})\n  node: ${JSON.stringify(want)}\n  core: ${JSON.stringify(sent)}`);
  // ---- the answer: the turn's last assistant message, as the client's feed completes it ----
  const messages = threadNotes.filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'agentMessage').map((n) => n.params.item);
  const answer = messages.at(-1)?.text ?? null;
  if (answer !== recorded.answer) failures.push(`the answer is ${JSON.stringify(answer)}, Node's ${JSON.stringify(recorded.answer)}`);
  // ---- the approval cards ----
  if (!isDeepStrictEqual(cards, recorded.cards)) failures.push(`approval cards ${JSON.stringify(cards)}, Node's ${JSON.stringify(recorded.cards)}`);
  // ---- the completion: Node's stored answer row carries `meta.transcript.completion.status` ----
  // The verb names the finished answer (the client's choice in Node, the core's for its protocol clients); the row's `status` and
  // `elapsedMs` have no counterpart a protocol client reads (it reads the turn's own status, `turn/completed`).
  const verb = recorded.stored.at(-1)?.meta?.transcript?.completion?.verb ?? null;
  const coreVerb = messages.at(-1)?.meta?.ext?.completionVerb ?? null;
  if (coreVerb !== verb) failures.push(`the answer's completion verb is ${JSON.stringify(coreVerb)}, Node's ${JSON.stringify(verb)}`);
  if (completed.params.turn?.status !== 'completed') failures.push(`the turn ended ${JSON.stringify(completed.params.turn?.status)}, not completed`);
  console.log(`${recorded.name}: ${sent.length} request(s), answer, cards and completion verb as Node recorded them`);
} catch (error) {
  failures.push(`${error.message}${seen ? ` (model endpoint hit by: ${hits.join(", ")}; last seen: ${seen})` : ''}${stderr ? `\nmixdogd stderr:\n${stderr.slice(-2000)}` : ''}`);
} finally {
  failures.push(...(await endWorld()));
}
return failures;
}