#!/usr/bin/env node
// A built mixdogd driven for real against Node's recording (`native/core/fixtures/call-tool/golden.json`): a scripted OpenAI-chat
// endpoint is the model (so the session is a bridge session) and plays a recorded scenario's script. It FAILS (exit 1) unless what a
// client of the core can observe equals the recording, exactly: what the model was sent (every non-system message whole, less
// NOT_ON_THE_WIRE) and the tools both sessions offer, the turn's answer, the approval cards, and the turn's completion. What the two
// sessions do not share (the system prompt, the core thread's extra tools) is listed in NOT_SHARED with the tests that compare it. Every wait is on an event (the discovery file appearing,
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
// What the model is sent is compared by subtraction, as `bridge_calls.rs` compares: each recorded request message whole, less these
// fields, equals the message the core put on the wire, converted field by field (a wire field the conversion does not know fails).
// None of them is on the OpenAI-chat wire the model reads; each is compared in-process (`bridge_calls.rs` `NOT_COMPARED`, where the
// stored rows, events, callbacks, hooks, timeline, audit and trace of these scenarios are compared too).
const NOT_ON_THE_WIRE = ['createdAt', 'toolKind', 'toolTiming', 'cacheTier', 'meta.transcript'];
// The tools each request carried, as Node's `onUsageDelta` `sendTools` lists them, less what a request's definition has no place for
// (a registry document's `title`, `annotations`, `trigger`).
const NOT_IN_A_DEFINITION = ['title', 'annotations', 'trigger'];

// What the two sessions do not share, and so is not compared here. The recording's session is the recorder's `createSession` (with
// `skipSkills`, the recorder's probe tools, model `fake-model`, a work folder holding x.txt, no workflow, orchestration or feature
// denials), not a desktop task thread; the built core runs a desktop task thread. Where each is compared against Node instead:
const NOT_SHARED = [
  {
    what: 'the system messages of every request',
    why: "the session's own prompt: skills, workflow, orchestration, deferred tools, environment and the feature-gated rule blocks follow the session's inputs, and the two sessions' inputs differ",
    comparedIn: [
      'composition from the same inputs, lead sessions included (`sess_lead_a2`, `sess_home_lead`): mixdog-core run_host/prompt_session_tests.rs `creation_composes_the_blocks_and_fields_nodes_session_starts_with`, `every_step_of_a_session_leaves_the_system_messages_nodes_leave` (fixtures/prompt, record-prompt.mjs)',
      'the feature gates that drop rule blocks and tools (visualize without a desktop bridge among them): mixdog-core run_host/workflow_surface/denials_tests.rs `the_feature_gates_equal_nodes`, `the_live_denials_equal_nodes` (fixtures/workflow-surface)',
      "a desktop task thread's prompt composed end to end from its live inputs: no test",
    ].join('; '),
  },
  {
    what: "the tools only the core's thread offers: agent, web_search, Skill, ask_user",
    why: "the recorder's session has no agent catalog, search, skills or ask_user; a desktop lead thread offers them",
    comparedIn: [
      'each definition: mixdog-tools fs/tests.rs `the_builtin_tools_are_nodes_definitions` and the other users of fixtures/tool-definitions (record-tool-definitions.mjs)',
      "the request surface built from a session's tools: mixdog-agent boundary.rs `the_request_tools_adopt_changes_as_node_does`, mixdog-core run_host/context_world.rs `the_request_snapshot_follows_node` (fixtures/request-tools)",
      'which tools a desktop lead thread is offered, end to end: no test',
    ].join('; '),
  },
];
const CORE_ONLY_TOOLS = ['agent', 'web_search', 'Skill', 'ask_user'];

// The record less the listed paths (`a.b` reaches into a field); an object the removal empties goes with it.
const without = (record, paths) => {
  const kept = { ...record };
  for (const path of paths) {
    const [key, ...rest] = path.split('.');
    if (!(key in kept)) continue;
    if (!rest.length) delete kept[key];
    else {
      kept[key] = without(kept[key], [rest.join('.')]);
      if (!Object.keys(kept[key]).length) delete kept[key];
    }
  }
  return kept;
};

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

// The OpenAI-chat message the core sent, in the recording's names, every field converted; a field it does not know is kept under its
// wire name, so that it fails the comparison.
const WIRE_FIELDS = new Set(['role', 'content', 'tool_calls', 'tool_call_id']);
const asRecorded = (m) => ({
  ...Object.fromEntries(Object.entries(m).filter(([key]) => !WIRE_FIELDS.has(key))),
  role: m.role,
  content: m.content ?? '',
  ...(m.tool_calls?.length ? { toolCalls: m.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments) })) } : {}),
  ...(m.tool_call_id ? { toolCallId: m.tool_call_id } : {}),
});
// A tool definition the core sent, in the names of Node's `sendTools`.
const asSendTool = (tool) => {
  const { name, description, parameters, ...rest } = tool.function;
  return { ...(tool.type === 'function' ? {} : { type: tool.type }), ...rest, name, description, inputSchema: parameters };
};
// Where two values first differ, as a path and the two leaves.
const firstDifference = (node, core, path) => {
  if (Array.isArray(node) && Array.isArray(core)) {
    for (let i = 0; i < Math.min(node.length, core.length); i++) if (!isDeepStrictEqual(node[i], core[i])) return firstDifference(node[i], core[i], `${path}[${i}]`);
    return `${path}: node has ${node.length} item(s), core has ${core.length}`;
  }
  if (node && core && typeof node === 'object' && typeof core === 'object') {
    for (const key of new Set([...Object.keys(node), ...Object.keys(core)])) {
      if (!(key in core)) return `${path}.${key}: node has ${JSON.stringify(node[key]).slice(0, 300)}, core has none`;
      if (!(key in node)) return `${path}.${key}: core has ${JSON.stringify(core[key]).slice(0, 300)}, node has none`;
      if (!isDeepStrictEqual(node[key], core[key])) return firstDifference(node[key], core[key], `${path}.${key}`);
    }
  }
  return `${path}: node ${JSON.stringify(node).slice(0, 600)}, core ${JSON.stringify(core).slice(0, 600)}`;
};

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
  await withDeadline(
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    }),
    'the scripted model endpoint listening',
    30_000
  );
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
  // ---- what the model was sent, request by request: every non-system message whole less NOT_ON_THE_WIRE (system: NOT_SHARED) ----
  const conversation = (messages) => messages.filter((m) => m.role !== 'system').map((m) => without(m, NOT_ON_THE_WIRE));
  const sent = requests.map((request) => conversation(request.messages.map(asRecorded)));
  const want = recorded.requests.map(conversation);
  if (!isDeepStrictEqual(sent, want)) failures.push(`what the model was sent differs from the recording: ${firstDifference(want, sent, 'requests')}`);
  // Each request still carries the system prompt, ahead of the conversation, as Node's did.
  for (const [n, request] of requests.entries()) {
    const roles = request.messages.map((m) => m.role);
    const leading = roles.findIndex((role) => role !== 'system');
    if (leading < 1 || roles.slice(leading).includes('system')) failures.push(`request ${n}: the system messages are not the request's leading messages: ${roles.join(', ')}`);
  }
  // ---- the tools each request carried: every tool Node's request carried (`sendTools` of its `onUsageDelta`, less
  // NOT_IN_A_DEFINITION), definition for definition and in Node's order; the core's thread may add only CORE_ONLY_TOOLS (NOT_SHARED) ----
  const sentTools = requests.map((request) => (request.tools ?? []).map(asSendTool));
  const wantTools = recorded.callbacks.filter((c) => c.ev === 'onUsageDelta').map((c) => c.args[0].sendTools.map((tool) => without(tool, NOT_IN_A_DEFINITION)));
  const shared = sentTools.map((tools) => tools.filter((tool) => !CORE_ONLY_TOOLS.includes(tool.name)));
  if (!isDeepStrictEqual(shared, wantTools)) failures.push(`the tools both sessions offer differ from the recording: ${firstDifference(wantTools, shared, 'tools')}`);
  const extra = [...new Set(sentTools.flat().map((tool) => tool.name).filter((name) => CORE_ONLY_TOOLS.includes(name)))];
  if (!isDeepStrictEqual(extra, CORE_ONLY_TOOLS)) failures.push(`the core's thread was to offer exactly ${CORE_ONLY_TOOLS.join(', ')} beyond Node's, and offered ${extra.join(', ')}`);
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
  if (!failures.length) console.log(`${recorded.name}: ${sent.length} request(s) with their tools, answer, cards and completion as Node recorded them`);
} catch (error) {
  failures.push(`${error.message}${seen ? ` (model endpoint hit by: ${hits.join(", ")}; last seen: ${seen})` : ''}${stderr ? `\nmixdogd stderr:\n${stderr.slice(-2000)}` : ''}`);
} finally {
  failures.push(...(await endWorld()));
}
return failures;
}