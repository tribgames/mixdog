#!/usr/bin/env node
// Drives a built `mixdogd` through the scenarios of native/core/fixtures/read-only-deadline/golden.json (one core per scenario, an
// isolated profile, the scenario's `env` laid over its environment, a scripted OpenAI-chat provider, the held file's oplock taken
// before the turn and released after it, as in the recording) and compares, whole and in order, with Node's: the provider request
// count, the tool messages of each request after the first, and the scenario's history/tool-failures.jsonl rows (normalised by
// lib/tool-failure-rows.mjs as the recorder normalised Node's).
//   MIXDOG_RECORDER_SCRATCH=<the recording's scratch parent> node replay-read-only-deadline.mjs --mixdogd <exe> [--only <n>,<n>]
// The exit code is 1 on any difference.
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILES, HELD_FILE, holdOplock, scenarios } from './lib/read-only-deadline-scenarios.mjs';
import { rowsByScenario } from './lib/tool-failure-rows.mjs';
import { readJobReport, spawnInJob } from './lib/job-run.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..', '..');
const golden = JSON.parse(readFileSync(join(repo, 'native/core/fixtures/read-only-deadline/golden.json'), 'utf8'));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const only = arg('--only', null)?.split(',').map(Number);
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
const CUSTOM = 'custom-11111111-1111-4111-8111-111111111111';
const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};
const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
  res.end();
};
const chunk = (delta, finish = null) => ({ id: 's', object: 'chat.completion.chunk', created: 0, model: golden.model, choices: [{ index: 0, delta, finish_reason: finish }] });
const text = (content) => (typeof content === 'string' ? content : JSON.stringify(content));

// `requests` gets, per request, the tool messages after its last assistant message (what the request answers).
function provider(replies, requests) {
  let n = 0;
  const server = createServer((req, res) => {
    const body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: golden.model, object: 'model' }] }));
      }
      const messages = JSON.parse(Buffer.concat(body).toString('utf8')).messages;
      const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
      requests.push(messages.slice(lastAssistant + 1).filter((m) => m.role === 'tool').map((m) => text(m.content)));
      const step = replies[n++];
      if (!step) return sse(res, [chunk({ role: 'assistant', content: 'extra' }), chunk({}, 'stop'), '[DONE]']);
      if (!step.calls.length) return sse(res, [chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop'), '[DONE]']);
      const tool_calls = step.calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      sse(res, [chunk({ role: 'assistant', tool_calls }), chunk({}, 'tool_calls'), '[DONE]']);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ baseURL: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(c); }) })));
}

async function loadLibs() {
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) { return s === '@mixdog/protocol' ? { url: ${JSON.stringify(pathToFileURL(join(repo, 'packages/protocol/src/index.ts')).href)}, shortCircuit: true } : next(s, c); }`)}`);
  return { ws: (await import('ws')).default, client: await import(pathToFileURL(join(repo, 'packages/protocol-client/src/index.ts')).href) };
}

/** Runs one scenario on a fresh core in a job object of its own (lib/job-run.mjs); ending the job on any failure path ends the core's tree. */
async function runScenario(scenario, root, ws, bin, libs) {
  const home = join(root, 'home');
  const p = { data: join(home, '.mixdog', 'data'), runtime: join(root, 'runtime'), appData: join(home, 'AppData', 'Roaming'), local: join(home, 'AppData', 'Local'), tmp: join(root, 'tmp'), bin: join(root, 'bin') };
  for (const d of Object.values(p)) mkdirSync(d, { recursive: true });
  for (const entry of readdirSync(ws)) rmSync(join(ws, entry), { recursive: true, force: true });
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(ws, name), content);
  const cleanups = [];
  let child;
  let exited;
  let client;
  const requests = [];
  try {
    const prov = await deadline(provider(scenario.replies, requests), 30_000, 'the scripted provider listening');
    cleanups.push(() => deadline(prov.close(), 30_000, 'the scripted provider closing'));
    writeFileSync(join(p.data, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { [CUSTOM]: { type: 'custom', name: 'rod', protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: golden.model }] } } } }));
    const exe = join(p.bin, 'mixdogd.exe');
    copyFileSync(bin, exe);
    writeFileSync(join(p.bin, 'js-runtime.json'), JSON.stringify({ program: process.execPath, packageRoot: repo }));
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
    Object.assign(env, { MIXDOG_DATA_DIR: p.data, MIXDOG_HOME: join(home, '.mixdog'), MIXDOG_CONFIG_DIR: join(home, '.mixdog'), MIXDOG_DESKTOP_USER_DATA: join(p.appData, 'Mixdog'), MIXDOG_RUNTIME_ROOT: p.runtime, MIXDOG_SKIP_USER_DATA_BACKUP: '1', HOME: home, USERPROFILE: home, APPDATA: p.appData, LOCALAPPDATA: p.local, TEMP: p.tmp, TMP: p.tmp, NO_PROXY: '127.0.0.1,localhost' }, scenario.env);
    const holder = await holdOplock(join(ws, HELD_FILE), join(root, 'oplock-holder.ps1'));
    let released = null;
    const release = () => (released ??= holder.release());
    cleanups.push(release);
    const stderrFile = process.env.REPLAY_STDERR ? openSync(process.env.REPLAY_STDERR, 'a') : 'ignore';
    child = spawnInJob(exe, ['serve'], { env, cwd: root, stdio: ['ignore', 'ignore', stderrFile], report: join(root, 'job.json') });
    if (typeof stderrFile === 'number') closeSync(stderrFile);
    exited = new Promise((r) => child.once('exit', r));
    const doc = await deadline(new Promise((res, rej) => {
      const file = join(p.runtime, 'daemon.json');
      const check = () => { try { const d = JSON.parse(readFileSync(file, 'utf8')); if (d.core?.state === 'blocked') rej(new Error('core blocked')); if (d.core?.state === 'serving' && d.core.rpc?.port) res(d); } catch {} };
      const w = watch(p.runtime, check);
      cleanups.push(() => w.close());
      child.once('exit', (code) => rej(new Error(`the core exited (${code}) before it was serving`)));
      check();
    }), 120_000, 'the core serving');
    const { ws: WebSocket, client: lib } = libs;
    let turnCompleted;
    const completed = new Promise((r) => { turnCompleted = r; });
    client = await deadline(lib.connect({
      target: { id: 'local' },
      connector: { async open(_t, sink) {
        const socket = new WebSocket(`ws://127.0.0.1:${doc.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${doc.endpoints.session.token}` }, perMessageDeflate: false });
        return deadline(new Promise((res, rej) => {
          socket.on('open', () => res({ send: (t) => socket.send(t), close: (c, r) => socket.close(c, r) }));
          socket.on('message', (d) => sink.frame(d.toString('utf8')));
          socket.on('close', (c, r) => sink.closed(c, r.toString('utf8')));
          socket.on('error', rej);
        }), 30_000, 'the WebSocket to the core opening').catch((error) => { socket.terminate(); throw error; });
      } },
      clientInfo: { name: 'rod-replay', title: 'rod-replay', version: String(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version), kind: 'tui' },
      capabilities: {},
      threadReducer: {
        ...lib.sessionReducer,
        apply(state, notification) {
          if (notification.method === 'turn/completed') turnCompleted();
          return lib.sessionReducer.apply(state, notification);
        },
      },
      clock: { sleep: (ms) => Promise.reject(new Error(`the client asked to sleep ${ms} ms (a reconnect backoff): the connection was lost`)) },
      random: Math.random,
    }), 60_000, 'the protocol connection to the core (WebSocket open and initialize)');
    // A headless user session, as the recording's (record-tool-failures.mjs's replay builds the same).
    const session = { toolProfile: 'headless', toolMode: 'full', approvalMode: 'implicit', disallowDelegation: true, autoWakeCompletions: false, webSearch: false, memory: false };
    const started = await deadline(client.call('thread/start', { kind: 'task', session, projectPath: ws, draft: { projectPath: ws, route: { provider: CUSTOM, model: golden.model }, workflowId: 'headless', orchestrationMode: 'none' } }), 60_000, 'thread/start');
    const threadId = started.thread.id;
    await deadline(client.resumeThread(threadId, { lastItems: 10 }), 30_000, 'thread/resume');
    await deadline(client.call('turn/start', { threadId, input: { prompt: 'go', options: {} } }), 60_000, 'turn/start');
    await deadline(completed, 120_000, 'the scripted turn completing');
    await deadline(client.close(), 30_000, 'the client closing');
    client = null;
    // The held read is let go before the stop, as the recording let it go before its exit.
    await release();
    const stopping = new AbortController();
    const stopped = await deadline(
      fetch(`http://127.0.0.1:${doc.core.control.port}/mgmt/stop`, { method: 'POST', headers: { authorization: `Bearer ${doc.endpoints.session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'whenIdle', reason: 'quit' }), signal: stopping.signal }),
      30_000,
      'the core answering /mgmt/stop',
    ).finally(() => stopping.abort());
    if (!stopped.ok) throw new Error(`/mgmt/stop answered ${stopped.status}`);
    await deadline(exited, 30_000, 'the core exiting');
    const job = readJobReport(join(root, 'job.json'));
    if (job.exitCode !== 0) throw new Error(`the core exited with ${job.exitCode}`);
    const file = join(p.data, 'history', 'tool-failures.jsonl');
    return { threadId, dataDir: p.data, text: existsSync(file) ? readFileSync(file, 'utf8') : '', requests };
  } finally {
    const problems = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { problems.push(error); }
    }
    if (client) {
      try { await deadline(client.close(), 30_000, 'the client closing'); } catch (error) { problems.push(error); }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await deadline(exited, 30_000, 'the core\'s job host ending after its kill');
    }
    if (problems.length) throw problems[0];
  }
}

const bin = resolve(arg('--mixdogd'));
if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent the recording was made under (the workspace path length is part of the rows)');
// This run's own folder; the workspace is `<it>\ws`, the same shape (and length) as the recorder's `<scratch>\rod-rec-XXXXXX\ws`.
const base = mkdtempSync(join(scratch, 'rod-rpl-'));
const ws = join(base, 'ws');
mkdirSync(ws);
let bad = 0;
let failure = null;
try {
  if (ws.length !== golden.workspaceLength) throw new Error(`the workspace ${ws} is ${ws.length} characters, the recorded one ${golden.workspaceLength}: use the recorder's scratch parent (MIXDOG_RECORDER_SCRATCH)`);
  if (JSON.stringify(scenarios()) !== JSON.stringify(golden.scenarios)) throw new Error('the scenarios are not the recorded ones');
  if (only && !only.every((i) => golden.scenarios[i])) throw new Error(`--only names a scenario the recording does not have: ${only}`);
  const libs = await loadLibs();
  for (const [i, scenario] of golden.scenarios.entries()) {
    if (only && !only.includes(i)) continue;
    const { threadId, dataDir, text: file, requests } = await runScenario(scenario, join(base, `s${i}`), ws, bin, libs);
    const want = golden.results[i];
    if (requests.length !== want.sends) {
      bad += 1;
      console.log(`DIFF ${i} ${scenario.name}: ${requests.length} provider requests, Node ${want.sends}`);
    }
    const toolMessages = requests.slice(1);
    const sameMessages = JSON.stringify(toolMessages) === JSON.stringify(want.toolMessages);
    console.log(`${sameMessages ? 'SAME' : 'DIFF'} ${i} ${scenario.name}: tool messages`);
    if (!sameMessages) {
      bad += 1;
      console.log(`   core: ${JSON.stringify(toolMessages)}\n   node: ${JSON.stringify(want.toolMessages)}`);
    }
    const sessions = golden.scenarios.map((_, k) => (k === i ? threadId : undefined));
    const got = rowsByScenario(file, sessions, ws, dataDir)[i];
    const rows = golden.rows[i];
    const sameRows = got.length === rows.length && got.every((line, k) => line === rows[k]);
    console.log(`${sameRows ? 'SAME' : 'DIFF'} ${i} ${scenario.name}: ${got.length} failure rows, Node ${rows.length}`);
    if (!sameRows) {
      bad += 1;
      for (let k = 0; k < Math.max(got.length, rows.length); k += 1) if (got[k] !== rows[k]) console.log(`  row ${k}\n   core: ${got[k]}\n   node: ${rows[k]}`);
    }
  }
} catch (error) {
  failure = error;
}
if (failure) {
  console.log(`the run's folder ${base} is kept`);
  throw failure;
}
if (bad) console.log(`the run's folder ${base} is kept`);
else rmSync(base, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
