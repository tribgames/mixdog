#!/usr/bin/env node
// A built mixdogd driven for real: a scripted OpenAI-chat endpoint is the model (so the session is a bridge session) and the script is
// what the model says, turn by turn. It FAILS (exit 1) unless the model got what Node's `goal` tool answers (goal-tool-exec.mjs:12-15:
// `{"goal":null|{id,status,timeUsedMs,blocker?},"remaining_ms":null|n}`) and the turn ended with the script's last text; every wait
// is on an event (the discovery file appearing, a thread notification, the core's exit) under a deadline that names what did not happen.
//   node benchmarks/rust-core/recorders/replay-call-tool-live.mjs <mixdogd.exe> <scenario>
// scenarios: call-direct-load | call-no-load | direct-after-load | goal-block
// Each run has a world folder of its own (mkdtemp), so a run never meets the files of another. The core is ended through its own stop
// (`mixdogd ctl stop --when-idle`), awaited on its exit; a cluster still running for the world is stopped by `pg_ctl stop -m fast -D`;
// a process still naming the world is not killed: the run fails naming it and the world stays.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './lib/common.mjs';
import { endSandbox } from './sandbox-janitor.mjs';

const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const [exe, scenarioName] = process.argv.slice(2);

const say = (id, name, args) => ({ calls: [{ id, name, arguments: args }] });
const GOAL_ARGS = { action: 'block', blocker: 'Waiting for the user to pick the notification sound.' };
const NO_GOAL = '{"goal":null,"remaining_ms":null}';
const SCENARIOS = {
  'call-direct-load': { script: [say('c1', 'load_tool', { names: ['goal'] }), say('c2', 'call_tool', { name: 'goal', arguments: { action: 'status' } }), { text: 'done' }], goalAnswer: (text) => text === NO_GOAL },
  'call-no-load': { script: [say('c1', 'call_tool', { name: 'goal', arguments: { action: 'status' } }), { text: 'done' }], goalAnswer: (text) => text === NO_GOAL },
  'direct-after-load': { script: [say('c1', 'load_tool', { names: ['goal'] }), say('c2', 'goal', { action: 'status' }), { text: 'done' }], goalAnswer: (text) => text === NO_GOAL },
  'goal-block': {
    goal: 'Pick the notification sound',
    script: [say('c1', 'load_tool', { names: ['goal'] }), say('c2', 'call_tool', { name: 'goal', arguments: GOAL_ARGS }), { text: 'done' }],
    goalAnswer: (text) => {
      const answer = JSON.parse(text);
      return answer.goal?.status === 'blocked' && answer.goal.blocker === GOAL_ARGS.blocker && answer.remaining_ms === null;
    },
  },
};
const scenario = SCENARIOS[scenarioName];
if (!exe || !scenario) {
  console.error(`usage: replay-call-tool-live.mjs <mixdogd.exe> <${Object.keys(SCENARIOS).join('|')}>`);
  process.exit(2);
}

const world = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'call-tool-live-'));
const dataDir = join(world, 'data');
let server = null;
let child = null;
let client = null;
let stderr = '';
let seen = '';
const hits = [];
let served = () => {};
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
    await client?.close();
  } catch (error) {
    ended.push(`closing the client: ${error.message}`);
  }
  if (child && child.exitCode === null) {
    const stop = spawnSync(exe, ['ctl', 'stop', '--when-idle', '--reason', 'quit'], { env: coreEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (stop.error || stop.status !== 0) ended.push(`mixdogd ctl stop answered ${stop.error?.message ?? stop.status}: ${stop.stderr}`);
    try {
      await waitOn('mixdogd exiting after its stop', 60_000, (attempt) => (child.once('exit', attempt), () => child.off('exit', attempt)), async () => child.exitCode !== null || child.signalCode !== null);
    } catch (error) {
      ended.push(error.message);
    }
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  ended.push(...endSandbox(world, 0, dataDir));
  return ended;
}

let coreEnv = null;
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
      res.once('finish', () => served());
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
  client = await connect({
    target: { id: 'core' },
    connector: createWsConnector(async () => endpoint),
    clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
    capabilities: { optOutNotificationMethods: [], experimentalApi: false },
    threadReducer: sessionReducer,
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
  client.on((event) => {
    if (event.type === 'serverRequest') client.respond(event.request.id, { result: { decision: 'approve', approved: true } });
  });
  const saved = await rpc('account/saveCustomProvider', { input: { name: 'scripted', protocol: 'openai-chat', baseURL, apiKey: 'sk-x' } });
  const provider = saved?.id ?? saved?.provider?.id ?? saved?.providerId;
  const started = await rpc('thread/start', {
    kind: 'task',
    projectPath: join(world, 'project'),
    draft: { projectPath: join(world, 'project'), route: { provider, model: 'm-a' } },
    ...(scenario.goal ? {} : { initialInput: { prompt: 'go' } }),
  });
  const threadId = started.thread.id;
  if (scenario.goal) await rpc('thread/goal/set', { threadId, goal: scenario.goal });
  // Done once the model has said everything the script holds and the turn has ended. This client is told nothing of a thread's turns (no
  // event reaches it), so the waits are on what the core itself reports: every answer the scripted model gives is an event (`served`),
  // and once the last one is out the turn's end is read back-to-back, each read starting when the one before answered, never on a timer.
  const thread = await waitOn(
    'the turn ending',
    60_000,
    (attempt) => ((served = attempt), () => (served = () => {})),
    async () => {
      for (;;) {
        const read = await rpc('thread/read', { threadId, includeTurns: true });
        seen = `model steps taken ${step}/${scenario.script.length}; item types ${read?.items?.map((item) => item.type)}`;
        if (step < scenario.script.length) return null;
        if (read.items?.at(-1)?.type === 'turnEnd') return read;
      }
    }
  );
  // ---- what the model was given ----
  const toolAnswers = requests.flatMap((request) => request.messages.filter((m) => m.role === 'tool').map((m) => ({ id: m.tool_call_id, text: m.content })));
  const lastCall = scenario.script.filter((s) => s.calls).at(-1).calls[0].id;
  const answer = toolAnswers.findLast((a) => a.id === lastCall);
  if (!answer) failures.push(`the model was never given the answer of ${lastCall}`);
  else if (answer.text.includes('unknown tool')) failures.push(`${lastCall} was answered "unknown tool": ${answer.text}`);
  else if (!scenario.goalAnswer(answer.text)) failures.push(`${lastCall} was answered ${answer.text}, not what Node's goal tool answers`);
  const finalText = requests.at(-1).messages.at(-1);
  if (finalText.role !== 'tool' && finalText.role !== 'user') failures.push(`the last request ended with a ${finalText.role} message`);
  console.log(JSON.stringify({ scenario: scenarioName, requests: requests.length, toolAnswers, turnItems: thread.items?.length }, null, 1));
} catch (error) {
  failures.push(`${error.message}${seen ? ` (model endpoint hit by: ${hits.join(", ")}; last seen: ${seen})` : ''}${stderr ? `\nmixdogd stderr:\n${stderr.slice(-2000)}` : ''}`);
} finally {
  failures.push(...(await endWorld()));
}
for (const failure of failures) console.error(`FAIL ${scenarioName}: ${failure}`);
process.exit(failures.length ? 1 : 0);