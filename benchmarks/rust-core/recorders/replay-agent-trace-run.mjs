#!/usr/bin/env node
// Drives a built `mixdogd` through the scenarios of native/core/fixtures/agent-trace-run/golden.json (one core per scenario, an
// isolated profile, the scenario's `env` laid over its environment, a scripted OpenAI-chat provider, as in the recording) and
// compares, whole and in order, with Node's: the provider request count, the scenario's batch/tool/tool_slow rows of
// history/agent-trace.jsonl (normalised by lib/agent-trace-run-rows.mjs), its history/tool-failures.jsonl rows (normalised by
// lib/tool-failure-rows.mjs), as the recorder normalised Node's, and the workspace files as the run left them. The counts of the
// other trace kinds are not compared (MANIFEST.json). A reply marked stream: 'settled' keeps its response open after the finish
// chunk until the core has reported each call's early result (a tool item completed with its result). The scripted provider
// fails the scenario on the first request it does not list, naming it.
//   MIXDOG_RECORDER_SCRATCH=<the recording's scratch parent> node replay-agent-trace-run.mjs --mixdogd <exe> [--only <n>,<n>]
// The exit code is 1 on any difference.
//
// Evidence is written as it happens, so it outlives any end of the replay: the run's folder (named on the first line of output)
// is removed only after a run with no difference. The replay runs as a child of a supervising process, which writes the child's
// exit code and signal to <folder>\exit.json when it ends otherwise (a kill, a native crash). Each scenario folder <folder>\s<n>
// holds harness.jsonl (every wait with its deadline, as begun, ended or failed, and the outcome), requests.jsonl (every request
// the scripted provider received), events.jsonl (every notification the client received), core.stdout.log and core.stderr.log
// (the job host's and the core's), job.json (the job host's report, once the core exited) and the core's profile.
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILES, scenarios } from './lib/agent-trace-run-scenarios.mjs';
import { traceRowsByScenario } from './lib/agent-trace-run-rows.mjs';
import { rowsByScenario } from './lib/tool-failure-rows.mjs';
import { readJobReport, spawnInJob } from './lib/job-run.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..', '..');
const golden = JSON.parse(readFileSync(join(repo, 'native/core/fixtures/agent-trace-run/golden.json'), 'utf8'));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const only = arg('--only', null)?.split(',').map(Number);
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
const CUSTOM = 'custom-11111111-1111-4111-8111-111111111111';
// The scenario folder whose harness.jsonl takes the harness's own state.
let trail = null;
const note = (file, row) => { if (trail) appendFileSync(join(trail, file), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`); };
const deadline = (p, ms, what) => {
  let timer;
  note('harness.jsonl', { wait: what, deadlineMs: ms });
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).then(
    (value) => { note('harness.jsonl', { ended: what }); return value; },
    (error) => { note('harness.jsonl', { failed: what, error: String(error?.stack ?? error) }); throw error; },
  ).finally(() => clearTimeout(timer));
};
const sse = (res, chunks) => {
  // One write: the response the core receives ends in the bytes that carry its calls (crate::batch::settle_gate).
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join(''));
};
const chunk = (delta, finish = null) => ({ id: 's', object: 'chat.completion.chunk', created: 0, model: golden.model, choices: [{ index: 0, delta, finish_reason: finish }] });

/**
 * The core's edit runs as they come and go, seen from outside: each run holds its file's advisory lock (a `<hash>.mixdog-lock`
 * created and removed under LOCALAPPDATA\mixdog\locks), so a run that ended has added two names there. The core tells a client
 * nothing of a streamed call before its response ends; an edit's barrier lets it start only once the edits before it settled,
 * so the last edit of a reply having ended means every one before it settled.
 */
function editRuns(dir) {
  let names = 0;
  const waiters = [];
  let failed = null;
  const watcher = watch(dir, { recursive: true }, (event, name) => {
    if (event !== 'rename' || !String(name).endsWith('.mixdog-lock')) return;
    names += 1;
    note('harness.jsonl', { lockRename: String(name), names });
    for (const w of waiters.splice(0)) if (names >= w.at) w.resolve(); else waiters.push(w);
  });
  watcher.on('error', (error) => {
    failed = new Error(`watching the edit locks failed: ${error?.message ?? error}`);
    for (const w of waiters.splice(0)) w.reject(failed);
  });
  return {
    /** Resolves once `runs` more edit runs have ended. */
    ended(runs) {
      const at = names + 2 * runs;
      if (failed) return Promise.reject(failed);
      return names >= at ? Promise.resolve() : new Promise((resolve, reject) => waiters.push({ at, resolve, reject }));
    },
    close: () => watcher.close(),
  };
}

function provider(replies, counter, runs) {
  const server = createServer((req, res) => {
    const body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', async () => {
      // Every request is recorded; the scenario lists the model list (GET) and, per reply, one chat request of its
      // conversation: the prompt as the first user text, ending in the results of the reply before it.
      let parsed = null;
      try { parsed = JSON.parse(Buffer.concat(body).toString('utf8') || 'null'); } catch {}
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const textOf = (m) => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? '').join('') : '');
      const seen = { method: req.method, path: req.url, model: parsed?.model ?? null, firstUser: textOf(messages.find((m) => m?.role === 'user')).slice(0, 200) };
      counter.requests += 1;
      note('requests.jsonl', { ...seen, toolResults: messages.filter((m) => m?.role === 'tool').map((m) => m.tool_call_id) });
      if (req.method === 'GET' && /\/models$/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: golden.model, object: 'model' }] }));
      }
      const before = replies[counter.sends - 1];
      const tail = [];
      for (let k = messages.length - 1; k >= 0 && messages[k]?.role === 'tool'; k -= 1) tail.unshift(messages[k].tool_call_id);
      const listed = req.method === 'POST' && /\/chat\/completions$/.test(req.url) && seen.model === golden.model && seen.firstUser === 'go'
        && counter.sends < replies.length
        && JSON.stringify(tail) === JSON.stringify(before ? before.calls.map((c) => c.id) : []);
      if (!listed) {
        counter.failure ??= new Error(`provider request ${counter.requests} is not one the scenario lists: ${JSON.stringify(seen)}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'not a request of the scenario' } }));
      }
      const step = replies[counter.sends++];
      if (!step.calls.length) return sse(res, [chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop'), '[DONE]']);
      const tool_calls = step.calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      if (step.stream !== 'settled') return sse(res, [chunk({ role: 'assistant', tool_calls }), chunk({}, 'tool_calls'), '[DONE]']);
      // The chat wire hands its calls over at the finish chunk; the response stays open until every call's run has settled.
      if (!step.calls.every((c) => c.name === 'edit')) {
        counter.failure ??= new Error('a settled reply holds edits only (their runs are what the replay sees end)');
        return res.destroy();
      }
      const ended = runs.ended(step.calls.length);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of [chunk({ role: 'assistant', tool_calls }), chunk({}, 'tool_calls')]) res.write(`data: ${JSON.stringify(c)}\n\n`);
      try {
        await deadline(ended, 60_000, `the core's streamed runs of ${step.calls.map((c) => c.id).join(', ')} ending`);
      } catch (error) {
        counter.failure = error;
        return res.destroy();
      }
      res.end('data: [DONE]\n\n');
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
  trail = root;
  const cleanups = [];
  let child;
  let exited;
  let client;
  const counter = { sends: 0, failure: null, requests: 0 };
  let outcome = 'failed';
  try {
    const runs = editRuns(p.local);
    cleanups.push(() => runs.close());
    const prov = await deadline(provider(scenario.replies, counter, runs), 30_000, 'the scripted provider listening');
    cleanups.push(() => deadline(prov.close(), 30_000, 'the scripted provider closing'));
    writeFileSync(join(p.data, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { [CUSTOM]: { type: 'custom', name: 'atr', protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: golden.model }] } } } }));
    const exe = join(p.bin, 'mixdogd.exe');
    copyFileSync(bin, exe);
    writeFileSync(join(p.bin, 'js-runtime.json'), JSON.stringify({ program: process.execPath, packageRoot: repo }));
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
    Object.assign(env, { MIXDOG_DATA_DIR: p.data, MIXDOG_HOME: join(home, '.mixdog'), MIXDOG_CONFIG_DIR: join(home, '.mixdog'), MIXDOG_DESKTOP_USER_DATA: join(p.appData, 'Mixdog'), MIXDOG_RUNTIME_ROOT: p.runtime, MIXDOG_SKIP_USER_DATA_BACKUP: '1', HOME: home, USERPROFILE: home, APPDATA: p.appData, LOCALAPPDATA: p.local, TEMP: p.tmp, TMP: p.tmp, NO_PROXY: '127.0.0.1,localhost' }, scenario.env);
    const out = openSync(join(root, 'core.stdout.log'), 'a');
    const err = openSync(join(root, 'core.stderr.log'), 'a');
    try {
      child = spawnInJob(exe, ['serve'], { env, cwd: root, stdio: ['ignore', out, err], report: join(root, 'job.json') });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    exited = new Promise((r) => child.once('exit', (code, signal) => { note('harness.jsonl', { jobHostExited: code, signal }); r(code); }));
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
      clientInfo: { name: 'atr-replay', title: 'atr-replay', version: String(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version), kind: 'tui' },
      capabilities: {},
      threadReducer: {
        ...lib.sessionReducer,
        apply(state, notification) {
          note('events.jsonl', { notification });
          if (notification.method === 'turn/completed') turnCompleted();
          return lib.sessionReducer.apply(state, notification);
        },
      },
      clock: { sleep: (ms) => Promise.reject(new Error(`the client asked to sleep ${ms} ms (a reconnect backoff): the connection was lost`)) },
      random: Math.random,
    }), 60_000, 'the protocol connection to the core (WebSocket open and initialize)');
    // A headless user session, as the recording's.
    const session = { toolProfile: 'headless', toolMode: 'full', approvalMode: 'implicit', disallowDelegation: true, autoWakeCompletions: false, webSearch: false, memory: false };
    const started = await deadline(client.call('thread/start', { kind: 'task', session, projectPath: ws, draft: { projectPath: ws, route: { provider: CUSTOM, model: golden.model }, workflowId: 'headless', orchestrationMode: 'none' } }), 60_000, 'thread/start');
    const threadId = started.thread.id;
    await deadline(client.resumeThread(threadId, { lastItems: 10 }), 30_000, 'thread/resume');
    await deadline(client.call('turn/start', { threadId, input: { prompt: 'go', options: {} } }), 60_000, 'turn/start');
    await deadline(completed, 120_000, 'the scripted turn completing');
    if (counter.failure) throw counter.failure;
    await deadline(client.close(), 30_000, 'the client closing');
    client = null;
    // The stop's exit flush writes what is still queued, as Node's exit hooks did in the recording.
    const stopping = new AbortController();
    const stopped = await deadline(
      fetch(`http://127.0.0.1:${doc.core.control.port}/mgmt/stop`, { method: 'POST', headers: { authorization: `Bearer ${doc.endpoints.session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'whenIdle', reason: 'quit' }), signal: stopping.signal }),
      30_000,
      'the core answering /mgmt/stop',
    ).finally(() => stopping.abort());
    if (!stopped.ok) throw new Error(`/mgmt/stop answered ${stopped.status}`);
    await deadline(exited, 30_000, 'the core exiting');
    // A request the scenario does not list may come after the turn (a title generation released by its output).
    if (counter.failure) throw counter.failure;
    const job = readJobReport(join(root, 'job.json'));
    if (job.exitCode !== 0) throw new Error(`the core exited with ${job.exitCode}`);
    const text = (name) => { const file = join(p.data, 'history', name); return existsSync(file) ? readFileSync(file, 'utf8') : ''; };
    // The workspace as the run left it, read as the recorder read Node's.
    const finalFiles = Object.fromEntries(readdirSync(ws, { withFileTypes: true }).map((e) => (e.isFile() ? e.name : `${e.name}/`)).sort().map((name) => [name, name.endsWith('/') ? null : readFileSync(join(ws, name), 'utf8')]));
    outcome = 'ran';
    return { threadId, dataDir: p.data, trace: text('agent-trace.jsonl'), failures: text('tool-failures.jsonl'), sends: counter.sends, finalFiles };
  } catch (error) {
    note('harness.jsonl', { error: String(error?.stack ?? error) });
    throw error;
  } finally {
    note('harness.jsonl', { scenario: outcome });
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

function compare(label, got, want) {
  const same = got.length === want.length && got.every((line, k) => line === want[k]);
  console.log(`${same ? 'SAME' : 'DIFF'} ${label}: ${got.length} rows, Node ${want.length}`);
  if (!same) for (let k = 0; k < Math.max(got.length, want.length); k += 1) if (got[k] !== want[k]) console.log(`  row ${k}\n   core: ${got[k]}\n   node: ${want[k]}`);
  return same ? 0 : 1;
}

if (!arg('--base', null)) {
  // The supervisor: the run's folder is made and named before anything can fail, and how the replay ended is kept with it.
  if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent the recording was made under (the workspace path length is part of the rows)');
  // This run's own folder; the workspace is `<it>\ws`, the same shape (and length) as the recorder's `<scratch>\atr-rec-XXXXXX\ws`.
  const base = mkdtempSync(join(scratch, 'atr-rpl-'));
  console.log(`the run's folder is ${base}`);
  const replay = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2), '--base', base], { stdio: 'inherit', windowsHide: true });
  console.log(`the replay's pid is ${replay.pid}`);
  const [code, signal] = await new Promise((r) => replay.once('exit', (c, s) => r([c, s])));
  if (code !== 0) {
    writeFileSync(join(base, 'exit.json'), JSON.stringify({ pid: replay.pid, code, codeHex: code === null ? null : `0x${(code >>> 0).toString(16)}`, signal, at: new Date().toISOString() }));
    console.log(`the replay ended with code ${code}${signal ? ` (signal ${signal})` : ''}; the run's folder ${base} is kept`);
  }
  process.exit(code === 0 ? 0 : 1);
}

const bin = resolve(arg('--mixdogd'));
const base = arg('--base');
process.on('uncaughtExceptionMonitor', (error, origin) => appendFileSync(join(base, 'harness.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), [origin]: String(error?.stack ?? error) })}\n`));
process.report.directory = base;
process.report.reportOnFatalError = true;
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
    const got = await runScenario(scenario, join(base, `s${i}`), ws, bin, libs);
    if (got.sends !== golden.results[i].sends) {
      bad += 1;
      console.log(`DIFF ${i} ${scenario.name}: ${got.sends} provider requests, Node ${golden.results[i].sends}`);
    }
    const sessions = golden.scenarios.map((_, k) => (k === i ? got.threadId : undefined));
    bad += compare(`${i} ${scenario.name}: trace`, traceRowsByScenario(got.trace, sessions, ws)[i].rows, golden.trace[i]);
    bad += compare(`${i} ${scenario.name}: failures`, rowsByScenario(got.failures, sessions, ws, got.dataDir)[i], golden.failures[i]);
    const files = (f) => Object.entries(f).map(([name, content]) => JSON.stringify([name, content]));
    bad += compare(`${i} ${scenario.name}: files`, files(got.finalFiles), files(golden.finalFiles[i]));
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
