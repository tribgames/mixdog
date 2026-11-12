#!/usr/bin/env node
// Drives a built `mixdogd` through the multi-turn scenarios of native/core/fixtures/read-cache/golden.json (one core per scenario, an
// isolated profile, a scripted OpenAI-chat provider): the real turn path, tool batch, read tool, apply_patch tool and manual compaction
// of the core, several turns of ONE thread with the recorded step between them. Each turn's tool messages (what the model is shown of
// each of its calls, per request) are compared with Node's, whole and in order. The scenario that closes and resumes the session is not
// replayed here: a closed thread is tombstoned in the core and cannot be reached through the protocol; the Rust test
// `a_closed_and_resumed_session_reads_like_nodes` (mixdog-core, run_host/session_read_cache_replay.rs) replays it through the real run path.
//   MIXDOG_RECORDER_SCRATCH=<a scratch parent> node replay-read-cache.mjs --mixdogd <exe> [--only <n>,<n>]
// The exit code is 1 on any difference.
import { copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILES, scenarios } from './lib/read-cache-scenarios.mjs';
import { readJobReport, spawnInJob } from './lib/job-run.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..', '..');
const golden = JSON.parse(readFileSync(join(repo, 'native/core/fixtures/read-cache/golden.json'), 'utf8'));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const only = arg('--only', null)?.split(',').map(Number);
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
const CUSTOM = 'custom-11111111-1111-4111-8111-111111111111';
const CLOSE_SCENARIO = 'the session closed and resumed between the turns';
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

// The provider hands out the replies of the phase being driven (`script.queue`), and notes, per request after the first assistant message, the
// tool messages the request carries after the last assistant message: the same walk the recorder makes over Node's messages.
function provider(script) {
  const server = createServer((req, res) => {
    const body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: golden.model, object: 'model' }] }));
      }
      const messages = JSON.parse(Buffer.concat(body).toString('utf8')).messages ?? [];
      const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
      if (lastAssistant >= 0) script.sends.push(messages.slice(lastAssistant + 1).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
      const step = script.queue.shift();
      if (!step) return sse(res, [chunk({ role: 'assistant', content: 'extra' }), chunk({}, 'stop'), '[DONE]']);
      if (!step.calls.length) return sse(res, [chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop'), '[DONE]']);
      const tool_calls = step.calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
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

/** One scenario on a fresh core: the turns' tool messages, per turn, as the model was shown them. */
async function runScenario(scenario, root, ws, bin) {
  const home = join(root, 'home');
  const p = { data: join(home, '.mixdog', 'data'), runtime: join(root, 'runtime'), appData: join(home, 'AppData', 'Roaming'), local: join(home, 'AppData', 'Local'), tmp: join(root, 'tmp'), bin: join(root, 'bin') };
  for (const d of Object.values(p)) mkdirSync(d, { recursive: true });
  for (const entry of readdirSync(ws)) rmSync(join(ws, entry), { recursive: true, force: true });
  for (const [name, text] of Object.entries({ ...FILES, ...scenario.files })) writeFileSync(join(ws, name), text);
  const cleanups = [];
  let child;
  let exited;
  let client;
  const script = { queue: [], sends: [] };
  try {
    const prov = await deadline(provider(script), 30_000, 'the scripted provider listening');
    cleanups.push(() => deadline(prov.close(), 30_000, 'the scripted provider closing'));
    writeFileSync(join(p.data, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { [CUSTOM]: { type: 'custom', name: 'rc', protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: golden.model }] } } } }));
    const exe = join(p.bin, 'mixdogd.exe');
    copyFileSync(bin, exe);
    writeFileSync(join(p.bin, 'js-runtime.json'), JSON.stringify({ program: process.execPath, packageRoot: repo }));
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
    Object.assign(env, { MIXDOG_DATA_DIR: p.data, MIXDOG_HOME: join(home, '.mixdog'), MIXDOG_CONFIG_DIR: join(home, '.mixdog'), MIXDOG_DESKTOP_USER_DATA: join(p.appData, 'Mixdog'), MIXDOG_RUNTIME_ROOT: p.runtime, MIXDOG_SKIP_USER_DATA_BACKUP: '1', HOME: home, USERPROFILE: home, APPDATA: p.appData, LOCALAPPDATA: p.local, TEMP: p.tmp, TMP: p.tmp, NO_PROXY: '127.0.0.1,localhost' });
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
    // The turn's end is the core's own `turn/completed` on the feed of the thread this client watches.
    const completions = [];
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
      clientInfo: { name: 'rc-replay', title: 'rc-replay', version: String(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version), kind: 'tui' },
      capabilities: {},
      threadReducer: {
        ...lib.sessionReducer,
        apply(state, notification) {
          if (notification.method === 'turn/completed') completions.shift()?.();
          return lib.sessionReducer.apply(state, notification);
        },
      },
      clock: { sleep: (ms) => Promise.reject(new Error(`the client asked to sleep ${ms} ms (a reconnect backoff): the connection was lost`)) },
      random: Math.random,
    }), 60_000, 'the protocol connection to the core (WebSocket open and initialize)');
    cleanups.push(client.on((event) => {
      if (event.type === 'serverRequest' && event.request.method === 'item/tool/requestApproval') client.respond(event.request.id, { result: { approved: true, response: 'approve' } });
    }));
    const session = { toolProfile: 'headless', toolMode: 'full', approvalMode: 'implicit', disallowDelegation: true, autoWakeCompletions: false, webSearch: false, memory: false };
    const started = await deadline(client.call('thread/start', { kind: 'task', session, projectPath: ws, draft: { projectPath: ws, route: { provider: CUSTOM, model: golden.model }, workflowId: 'headless', orchestrationMode: 'none' } }), 60_000, 'thread/start');
    const threadId = started.thread.id;
    await deadline(client.resumeThread(threadId, { lastItems: 10 }), 30_000, 'thread/resume');
    const turns = [];
    const steps = [];
    for (const phase of scenario.phases) {
      if (phase.turn) {
        script.queue = [...phase.turn];
        script.sends = [];
        const done = new Promise((r) => completions.push(r));
        await deadline(client.call('turn/start', { threadId, input: { prompt: `go ${turns.length + 1}`, options: {} } }), 60_000, 'turn/start');
        await deadline(done, 120_000, `turn ${turns.length + 1} completing`);
        turns.push({ sends: script.sends, unused: script.queue.length });
      } else if (phase.write) {
        writeFileSync(join(ws, phase.write.file), phase.write.text);
        steps.push({ write: phase.write.file });
      } else if (phase.compact) {
        script.queue = [{ text: 'SUMMARY', calls: [] }];
        const result = await deadline(client.call('thread/compact/start', { threadId, opId: `compact-${steps.length}` }), 120_000, 'thread/compact/start');
        steps.push({ compact: { changed: result?.changed ?? null } });
      }
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
    return { turns, steps };
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bin = resolve(arg('--mixdogd'));
  if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name a scratch parent');
  const base = mkdtempSync(join(scratch, 'rc-rpl-'));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  let bad = 0;
  let failure = null;
  try {
    if (JSON.stringify(scenarios()) !== JSON.stringify(golden.scenarios)) throw new Error('the scenarios built here are not the recorded ones');
    for (const [i, scenario] of golden.scenarios.entries()) {
      if (only && !only.includes(i)) continue;
      if (scenario.name === CLOSE_SCENARIO) continue;
      const { turns, steps } = await runScenario(scenario, join(base, `s${i}`), ws, bin);
      const node = golden.results[i];
      const same = JSON.stringify(turns.map((t) => t.sends)) === JSON.stringify(node.turns.map((t) => t.sends))
        && JSON.stringify(turns.map((t) => t.unused)) === JSON.stringify(node.turns.map((t) => t.unused))
        && JSON.stringify(steps) === JSON.stringify(node.steps.filter((s) => !s.close).map((s) => (s.compact ? { compact: { changed: s.compact.changed } } : s)));
      if (!same) {
        bad += 1;
        console.log(`DIFF ${i} ${scenario.name}\n   core: ${JSON.stringify({ turns, steps })}\n   node: ${JSON.stringify({ turns: node.turns.map((t) => ({ sends: t.sends, unused: t.unused })), steps: node.steps })}`);
      } else {
        console.log(`SAME ${i} ${scenario.name}`);
      }
    }
  } catch (error) {
    failure = error;
  }
  if (failure) {
    console.error(`the run's folder ${base} is kept`);
    throw failure;
  }
  rmSync(base, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
}
