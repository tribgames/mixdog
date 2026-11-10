#!/usr/bin/env node
// A built mixdogd driven for real: a scripted OpenAI-chat endpoint is the model (so the session is a bridge session) and the
// script is what the model says, turn by turn. Prints what the model was offered and answered and what the client saw.
//   node benchmarks/rust-core/recorders/replay-call-tool-live.mjs <mixdogd.exe> <scenario> [world-dir]
// scenarios: call-direct-load | call-no-load | direct-after-load | goal-block
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './lib/common.mjs';

const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const [exe, scenarioName, worldArg] = process.argv.slice(2);
const world = worldArg ?? join(process.env.TEMP ?? '.', `call-tool-live-${scenarioName}`);

const say = (id, name, args) => ({ calls: [{ id, name, arguments: args }] });
const GOAL_ARGS = { action: 'block', blocker: 'Waiting for the user to pick the notification sound.' };
const SCENARIOS = {
  'call-direct-load': { script: [say('c1', 'load_tool', { names: ['goal'] }), say('c2', 'call_tool', { name: 'goal', arguments: { action: 'status' } }), { text: 'done' }] },
  'call-no-load': { script: [say('c1', 'call_tool', { name: 'goal', arguments: { action: 'status' } }), { text: 'done' }] },
  'direct-after-load': { script: [say('c1', 'load_tool', { names: ['goal'] }), say('c2', 'goal', { action: 'status' }), { text: 'done' }] },
  'goal-block': { goal: 'Pick the notification sound', script: [say('c1', 'load_tool', { names: ['goal'] }), say('c2', 'call_tool', { name: 'goal', arguments: GOAL_ARGS }), { text: 'blocked on the user' }] },
};
const scenario = SCENARIOS[scenarioName];

// ---- the scripted model ----
const requests = [];
let step = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const path = req.url.replace(/^\/v1/, '');
    if (path === '/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm-a' }] }));
    const request = JSON.parse(body || '{}');
    requests.push(request);
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
rmSync(world, { recursive: true, force: true });
for (const dir of ['runtime', 'data', 'home', 'config', 'project']) mkdirSync(join(world, dir), { recursive: true });
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_')) delete env[key];
Object.assign(env, { MIXDOG_RUNTIME_ROOT: join(world, 'runtime'), MIXDOG_DATA_DIR: join(world, 'data'), MIXDOG_HOME: join(world, 'home'), MIXDOG_CONFIG_DIR: join(world, 'config') });
const manifest = join(exe, '..', 'js-runtime.json');
if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
const child = spawn(exe, ['serve'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk));
// The core and everything it started, ended on every path; taskkill answers 128 when the process is already gone.
const killTree = () => {
  const ended = spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', timeout: 15_000 });
  if (ended.error || (ended.status !== 0 && ended.status !== 128)) throw new Error(`taskkill of mixdogd ${child.pid} failed: ${ended.error?.message ?? ended.status}`);
};
// Polls the state of the work until it is done, or fails naming what did not finish.
const within = async (label, ms, ready) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await ready();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${label}: not done after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const file = join(world, 'runtime', 'daemon.json');
const endpoint = await within('mixdogd publishing its discovery file', 60_000, () => {
  if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}:\n${stderr}`);
  try { return parseDiscovery(readFileSync(file, 'utf8')); } catch { return null; }
});
const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
const client = await connect({
  target: { id: 'core' },
  connector: createWsConnector(async () => endpoint),
  clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
  capabilities: { optOutNotificationMethods: [], experimentalApi: false },
  threadReducer: sessionReducer,
  clock: { sleep: () => Promise.reject(new Error('dropped')) },
  random: Math.random,
});
const seen = [];
client.on((event) => {
  if (event.type === 'serverRequest') {
    seen.push({ serverRequest: event.request.method, params: event.request.params });
    client.respond(event.request.id, { result: { decision: 'approve', approved: true } });
  } else seen.push(event);
});
const out = { scenario: scenarioName };
try {
  const saved = await client.call('account/saveCustomProvider', { input: { name: 'scripted', protocol: 'openai-chat', baseURL, apiKey: 'sk-x' } });
  out.saved = saved;
  const provider = saved?.id ?? saved?.provider?.id ?? saved?.providerId;
  const started = await client.call('thread/start', {
    kind: 'task',
    projectPath: join(world, 'project'),
    draft: { projectPath: join(world, 'project'), route: { provider, model: 'm-a' } },
    ...(scenario.goal ? {} : { initialInput: { prompt: 'go' } }),
  });
  out.started = started;
  const threadId = started.thread.id;
  if (scenario.goal) {
    out.goalSet = await client.call('thread/goal/set', { threadId, goal: scenario.goal });
  }
  // Done once the model has said everything the script holds and the turn has ended.
  out.thread = await within('the turn ending', 60_000, async () => {
    const read = await client.call('thread/read', { threadId, includeTurns: true });
    return step >= scenario.script.length && read.items?.at(-1)?.type === 'turnEnd' ? read : null;
  });
} catch (error) {
  out.error = String(error?.message ?? error);
  out.detail = error?.detail ?? null;
}
out.modelRequests = requests.map((r) => ({ tools: (r.tools ?? []).map((t) => t.function?.name), messages: r.messages?.slice(-3) }));
out.stderr = stderr.slice(-2000);
console.log(JSON.stringify(out, null, 1));
try {
  killTree();
} finally {
  server.close();
}
process.exit(out.error ? 1 : 0);
