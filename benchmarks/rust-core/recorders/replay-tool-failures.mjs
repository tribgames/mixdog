#!/usr/bin/env node
// Drives a built `mixdogd` through the scenarios of native/core/fixtures/tool-failures/golden.json (one core per scenario, an
// isolated profile, a scripted OpenAI-chat provider) and compares each scenario's rows of the history/tool-failures.jsonl its core
// wrote with Node's rows of that scenario, whole and in order, normalised by lib/tool-failure-rows.mjs as the recorder normalised
// Node's (session_id by the scenario's own thread, ts, tool_ms, and the workspace path: each run has its own folder, of the recorded
// path's length). Every scenario is compared; the full run (the default) is the verdict.
//   MIXDOG_RECORDER_SCRATCH=<the recording's scratch parent> node replay-tool-failures.mjs --mixdogd <exe> [--only <n>,<n>]
// The exit code is 1 on any difference.
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILES, scenarios } from './lib/tool-failure-scenarios.mjs';
import { leftAtExit, rowsByScenario } from './lib/tool-failure-rows.mjs';
import { readJobReport, spawnInJob } from './lib/job-run.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..', '..');
const golden = JSON.parse(readFileSync(join(repo, 'native/core/fixtures/tool-failures/golden.json'), 'utf8'));
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

function provider(replies) {
  let n = 0;
  const server = createServer((req, res) => {
    const body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: golden.model, object: 'model' }] }));
      }
      const step = replies[n++];
      if (!step) return sse(res, [chunk({ role: 'assistant', content: 'extra' }), chunk({}, 'stop'), '[DONE]']);
      if (!step.calls.length) return sse(res, [chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop'), '[DONE]']);
      const tool_calls = step.calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args) } }));
      sse(res, [chunk({ role: 'assistant', tool_calls }), chunk({}, 'tool_calls'), '[DONE]']);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ baseURL: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(c); }) })));
}

let libs;
async function loadLibs() {
  libs ??= (async () => {
    register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) { return s === '@mixdog/protocol' ? { url: ${JSON.stringify(pathToFileURL(join(repo, 'packages/protocol/src/index.ts')).href)}, shortCircuit: true } : next(s, c); }`)}`);
    return { ws: (await import('ws')).default, client: await import(pathToFileURL(join(repo, 'packages/protocol-client/src/index.ts')).href) };
  })();
  return libs;
}

/**
 * Runs one scenario on a fresh core and returns the file it wrote. `root` is this scenario's folder under the run's folder. The core runs
 * in a job object of its own (lib/job-run.mjs): every process it or its tools start is a member, and the members still in it when the
 * core exits are returned (and ended) for the caller to compare with Node's; ending the core's host on any failure path ends the job.
 */
async function runScenario(scenario, root, ws, bin) {
  const home = join(root, 'home');
  const p = { data: join(home, '.mixdog', 'data'), runtime: join(root, 'runtime'), appData: join(home, 'AppData', 'Roaming'), local: join(home, 'AppData', 'Local'), tmp: join(root, 'tmp'), bin: join(root, 'bin') };
  for (const d of Object.values(p)) mkdirSync(d, { recursive: true });
  for (const entry of readdirSync(ws)) rmSync(join(ws, entry), { recursive: true, force: true });
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(ws, name), text);
  const cleanups = [];
  let child;
  let exited;
  let client;
  try {
    const prov = await deadline(provider(scenario.replies), 30_000, 'the scripted provider listening');
    cleanups.push(() => deadline(prov.close(), 30_000, 'the scripted provider closing'));
    // A `full` scenario sees the MCP server `fx` (the recording connected the same stdio server under the session's scope).
    const mcpServers = scenario.full ? { fx: { command: process.execPath, args: ['fx-mcp.mjs'], cwd: ws } } : undefined;
    writeFileSync(join(p.data, 'mixdog-config.json'), JSON.stringify({ agent: { ...(mcpServers ? { mcpServers } : {}), providers: { [CUSTOM]: { type: 'custom', name: 'tf', protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: golden.model }] } } } }));
    // Node's recording injects the decision its hook bus returns for a legacy `toolBefore` rule ({ action, reason }); the core is
    // given that same rule in the profile's hooks.json.
    if (scenario.hook) writeFileSync(join(p.data, 'hooks.json'), JSON.stringify({ toolBefore: [{ tool: '*', action: scenario.hook.action, reason: scenario.hook.reason }] }));
    const exe = join(p.bin, 'mixdogd.exe');
    copyFileSync(bin, exe);
    writeFileSync(join(p.bin, 'js-runtime.json'), JSON.stringify({ program: process.execPath, packageRoot: repo }));
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
    Object.assign(env, { MIXDOG_DATA_DIR: p.data, MIXDOG_HOME: join(home, '.mixdog'), MIXDOG_CONFIG_DIR: join(home, '.mixdog'), MIXDOG_DESKTOP_USER_DATA: join(p.appData, 'Mixdog'), MIXDOG_RUNTIME_ROOT: p.runtime, MIXDOG_SKIP_USER_DATA_BACKUP: '1', HOME: home, USERPROFILE: home, APPDATA: p.appData, LOCALAPPDATA: p.local, TEMP: p.tmp, TMP: p.tmp, NO_PROXY: '127.0.0.1,localhost' });
    // REPLAY_STDERR=<file> keeps the core's stderr for a scenario that does not replay.
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
    const { ws: WebSocket, client: lib } = await loadLibs();
    // The turn's end is the core's own `turn/completed` on the feed of the thread this client watches (every notification of a watched
    // thread passes the reducer, in feed order).
    let turnCompleted;
    const completed = new Promise((r) => { turnCompleted = r; });
    // The protocol client has no deadline of its own for `initialize` (client.ts handshake: `this.rpc('initialize', …)` waits for
    // the answer however long): the whole connect, socket open and handshake, is bounded here. On the deadline the finally below
    // ends the core's job, which closes the socket under the pending connect.
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
      clientInfo: { name: 'tf-replay', title: 'tf-replay', version: String(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version), kind: 'tui' },
      capabilities: {},
      threadReducer: {
        ...lib.sessionReducer,
        apply(state, notification) {
          if (notification.method === 'turn/completed') turnCompleted();
          return lib.sessionReducer.apply(state, notification);
        },
      },
      // The client sleeps only to back off before a reconnect; this replay has none, so a use of the clock is a failure.
      clock: { sleep: (ms) => Promise.reject(new Error(`the client asked to sleep ${ms} ms (a reconnect backoff): the connection was lost`)) },
      random: Math.random,
    }), 60_000, 'the protocol connection to the core (WebSocket open and initialize)');
    // The approval answer the scenario scripts, given to every approval request the core holds.
    cleanups.push(client.on((event) => {
      if (event.type !== 'serverRequest' || event.request.method !== 'item/tool/requestApproval') return;
      const a = scenario.approval;
      client.respond(event.request.id, { result: { approved: a.approved, response: a.approved ? 'approve' : 'deny', reason: a.reason } });
    }));
    // The tool has started when it has made its file: a directory event, watched from before the turn starts so it cannot be missed.
    const toolStarted = scenario.abortWhenFile
      ? new Promise((resolve) => {
          const w = watch(ws, (_e, f) => { if (f === scenario.abortWhenFile) { w.close(); resolve(); } });
          cleanups.push(() => w.close());
        })
      : null;
    // `approvalMode: "implicit"` is a session with no approval surface; the approval scenario needs the client to be one.
    const session = scenario.full
      ? { toolMode: 'full', approvalMode: 'implicit', autoWakeCompletions: false, webSearch: false, memory: false }
      : { toolProfile: 'headless', toolMode: 'full', ...(scenario.approval ? {} : { approvalMode: 'implicit' }), disallowDelegation: true, autoWakeCompletions: false, webSearch: false, memory: false };
    const started = await deadline(client.call('thread/start', { kind: 'task', session, projectPath: ws, draft: { projectPath: ws, route: { provider: CUSTOM, model: golden.model }, ...(scenario.full ? {} : { workflowId: 'headless' }), orchestrationMode: 'none' } }), 60_000, 'thread/start');
    const threadId = started.thread.id;
    // A client sees a thread's run once it watches the thread, as the desktop does for the threads it shows (`thread/resume`); watched
    // before the turn starts.
    await deadline(client.resumeThread(threadId, { lastItems: 10 }), 30_000, 'thread/resume');
    if (scenario.full) {
      // The core connects a thread's MCP servers in the background; the recording connected `fx` before its turn, so the turn starts once the
      // core reports the server connected: asked once now and again at every event the core sends.
      const connected = (status) => { const s = JSON.stringify(status); return s.includes('"fx"') && /connected/i.test(s); };
      await deadline(new Promise((resolve, reject) => {
        const check = () => client.call('mcp/mcpStatus', { threadId }).then((status) => { if (connected(status)) resolve(); }, reject);
        cleanups.push(client.on(check));
        check();
      }), 60_000, 'the MCP server fx connecting');
    }
    const turn = await deadline(client.call('turn/start', { threadId, input: { prompt: 'go', options: {} } }), 60_000, 'turn/start');
    if (scenario.abortWhenFile) {
      await deadline(toolStarted, 60_000, `the tool creating ${scenario.abortWhenFile}`);
      await deadline(client.call('turn/interrupt', { threadId, turnId: turn.turnId }), 60_000, 'turn/interrupt');
      await deadline(completed, 60_000, 'the interrupted turn completing');
    } else {
      await deadline(completed, 120_000, 'the scripted turn completing');
    }
    await deadline(client.close(), 30_000, 'the client closing');
    client = null;
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
    // What the job still held when the core exited (ended since by the job host), compared with Node's by the caller.
    return { threadId, dataDir: p.data, text: existsSync(file) ? readFileSync(file, 'utf8') : '', left: leftAtExit(job), rawLeft: job.left };
  } finally {
    // Every step of the teardown is bounded and runs; the first that failed fails the scenario (after a failure of its own, that one).
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bin = resolve(arg('--mixdogd'));
  if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent the recording was made under (the workspace path length is part of the rows)');
  // This run's own folder; the workspace is `<it>\ws`, the same shape (and length) as the recorder's `<scratch>\tf-rec-XXXXXX\ws`.
  const base = mkdtempSync(join(scratch, 'tf-rpl-'));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  let bad = 0;
  let failure = null;
  try {
    // The recorded workspace's length is part of the rows (a cut lands inside an emoji at a fixed length), so this run's folder must have it.
    if (ws.length !== golden.workspaceLength) throw new Error(`the workspace ${ws} is ${ws.length} characters, the recorded one ${golden.workspaceLength}: use the recorder's scratch parent (MIXDOG_RECORDER_SCRATCH)`);
    if (JSON.stringify(scenarios(ws)) !== JSON.stringify(golden.scenarios)) throw new Error('the scenarios built for this workspace are not the recorded ones');
    for (const [i, scenario] of golden.scenarios.entries()) {
      if (only && !only.includes(i)) continue;
      const { threadId, dataDir, text, left, rawLeft } = await runScenario(scenario, join(base, `s${i}`), ws, bin);
      // What the core left running at its exit must be what Node left at its own (Node's helpers set aside), whole and in join order.
      if (JSON.stringify(left) !== JSON.stringify(golden.leftAtExit[i])) {
        bad += 1;
        console.log(`DIFF ${i} ${scenario.name}: left at exit\n   core: ${JSON.stringify(rawLeft)}\n   node: ${JSON.stringify(golden.leftAtExit[i])}`);
      }
      // The core's file of this scenario, normalised as Node's was. This core ran scenario i alone, so its thread is the only session
      // a row may name: a row of any other session (or of none) fails the run.
      const sessions = golden.scenarios.map((_, k) => (k === i ? threadId : undefined));
      const got = rowsByScenario(text, sessions, ws, dataDir)[i];
      const want = golden.rows[i];
      const same = got.length === want.length && got.every((line, k) => line === want[k]);
      console.log(`${same ? 'SAME' : 'DIFF'} ${i} ${scenario.name} (${got.length} rows, Node ${want.length})`);
      if (!same) {
        bad += 1;
        for (let k = 0; k < Math.max(got.length, want.length); k += 1) if (got[k] !== want[k]) console.log(`  row ${k}\n   core: ${got[k]}\n   node: ${want[k]}`);
      }
    }
  } catch (error) {
    failure = error;
  }
  // A failed run keeps its folder for a look (what each core left behind is its job report's, checked in `runScenario`).
  if (failure) {
    console.log(`the run's folder ${base} is kept`);
    throw failure;
  }
  if (bad) console.log(`the run's folder ${base} is kept`);
  else rmSync(base, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
}