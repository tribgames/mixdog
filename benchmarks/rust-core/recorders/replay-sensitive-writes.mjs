#!/usr/bin/env node
// Replays the sensitive-writes scenario (lib/sensitive-writes-scenario.mjs; Node's recording is
// native/core/fixtures/sensitive-writes/golden.json) against a built `mixdogd`: one isolated profile, a scripted OpenAI-chat
// provider, and this client as the desktop (it claims the browser host role and answers `host/browser/command` as the recorded
// bridge answered, and as the secret card it hands the password through `approval/provideSecret`). The first core runs the two
// turns and the compaction and is stopped; a second core on the same profile resumes the thread and runs the third turn.
//
// Then every file under the profile (data, home, AppData, temp, the runtime folder: whatever the cores wrote) is searched for the
// scenario's three values as UTF-8, JSON-escaped (plain and \uXXXX), UTF-16LE, base64 and base64url (lib/sensitive-writes-files.mjs
// `spellings`); every hit is printed as `file@offset (encoding of value)` and fails the run. The model input is compared with
// Node's per provider call: the text of each message (roles, contents, tool-call arguments), the values whole while the first
// process runs and the marker after the reload. The core's tool-failure log is compared with Node's file whole (normalised the
// same way). The exit code is 1 on any difference or hit.
//
//   MIXDOG_RECORDER_SCRATCH=<scratch parent> node benchmarks/rust-core/recorders/replay-sensitive-writes.mjs --mixdogd <exe>
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODE, FAILED, MODEL, REPLIES, SECRET, TURNS, browserAnswer } from './lib/sensitive-writes-scenario.mjs';
import { normalizeTree, scanSecrets } from './lib/sensitive-writes-files.mjs';
import { readJobReport, spawnInJob } from './lib/job-run.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..', '..');
const golden = JSON.parse(readFileSync(join(repo, 'native/core/fixtures/sensitive-writes/golden.json'), 'utf8'));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
const CUSTOM = 'custom-22222222-2222-4222-8222-222222222222';
const HOST_ID = 'sensitive-writes-desktop';
const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};
const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
  res.end();
};
const chunk = (delta, finish = null) => ({ id: 's', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });

/** The scripted provider: REPLIES in order across both cores; `requests` gets every request body. */
function provider(requests) {
  const server = createServer((req, res) => {
    const body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
      }
      const parsed = JSON.parse(Buffer.concat(body).toString('utf8'));
      requests.push(parsed);
      const step = REPLIES[requests.length - 1];
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

/** What the desktop answers a `host/browser/command`: the recorded bridge's answer for the same command (its `value`, or its
 *  error as a JSON-RPC error), and the core's two-phase secret fill (`secret_precheck`, `secret_fill`), which Node's desktop
 *  ran in its own process (the bridge's `secret_input`). */
function hostAnswer(params) {
  const input = params.input && typeof params.input === 'object' ? params.input : {};
  if (params.action === 'secret_precheck') return { result: { text: 'ready', hostId: HOST_ID } };
  if (params.action === 'secret_fill') return { result: browserAnswer({ action: 'secret_input' }).value };
  const answer = browserAnswer({ action: params.action, input });
  return answer.ok ? { result: answer.value } : { error: { code: -32000, message: answer.error } };
}

/** One core on the profile `p` until `script(client, threadId)` has run; then a graceful stop. */
async function runCore(p, bin, log, script) {
  const cleanups = [];
  let child;
  let exited;
  let client;
  try {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
    Object.assign(env, { MIXDOG_DATA_DIR: p.data, MIXDOG_HOME: p.mixdogHome, MIXDOG_CONFIG_DIR: p.mixdogHome, MIXDOG_DESKTOP_USER_DATA: join(p.appData, 'Mixdog'), MIXDOG_RUNTIME_ROOT: p.runtime, MIXDOG_SKIP_USER_DATA_BACKUP: '1', HOME: p.home, USERPROFILE: p.home, APPDATA: p.appData, LOCALAPPDATA: p.local, TEMP: p.tmp, TMP: p.tmp, NO_PROXY: '127.0.0.1,localhost', RUST_LOG: 'debug' });
    const stderr = openSync(log, 'a');
    child = spawnInJob(p.exe, ['serve'], { env, cwd: p.root, stdio: ['ignore', 'ignore', stderr], report: join(p.root, `job-${Date.now()}.json`) });
    closeSync(stderr);
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
    const turnWaiters = [];
    const compactionWaiters = [];
    const notifications = [];
    cleanups.push(() => writeFileSync(join(p.root, `notifications-${Date.now()}.json`), JSON.stringify(notifications, null, 1)));
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
      clientInfo: { name: 'sw-replay', title: 'sw-replay', version: String(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version), kind: 'desktop' },
      capabilities: { host: { browser: true } },
      threadReducer: {
        ...lib.sessionReducer,
        apply(state, notification) {
          notifications.push({ method: notification.method, params: notification.params });
          if (notification.method === 'turn/completed') for (const w of turnWaiters.splice(0)) w();
          // A compaction ends with its divider item (no turn of its own).
          if (notification.method === 'item/completed' && notification.params?.item?.type === 'contextCompaction') for (const w of compactionWaiters.splice(0)) w(notification.params.item);
          return lib.sessionReducer.apply(state, notification);
        },
      },
      clock: { sleep: (ms) => Promise.reject(new Error(`the client asked to sleep ${ms} ms (a reconnect backoff): the connection was lost`)) },
      random: Math.random,
    }), 60_000, 'the protocol connection to the core');
    await deadline(client.call('host/claim', { hostId: HOST_ID }), 30_000, 'host/claim');
    const serverRequests = [];
    cleanups.push(client.on((event) => {
      if (event.type !== 'serverRequest') return;
      const { method, params, id } = event.request;
      serverRequests.push({ method, params });
      if (method === 'host/browser/command') {
        const answer = hostAnswer(params);
        client.respond(id, answer);
        return;
      }
      if (/requestApproval$/.test(method)) {
        const secret = params?.request?.secret ?? params?.secret ?? null;
        if (secret?.requestId) {
          // The card: the value goes to the core first, then the answer that provides it.
          client.call('approval/provideSecret', { opId: `op-secret-${Date.now()}`, requestId: secret.requestId, secret: SECRET }).then(
            () => client.respond(id, { result: { approved: true, response: 'provide-secret' } }),
            (error) => client.respond(id, { error: { code: -32000, message: String(error?.message ?? error) } }),
          );
        } else client.respond(id, { result: { approved: true, response: 'approve' } });
        return;
      }
      client.respond(id, { error: { code: -32601, message: `the replay does not serve ${method}` } });
    }));
    const turnCompleted = () => new Promise((r) => turnWaiters.push(r));
    const compactionCompleted = () => new Promise((r) => compactionWaiters.push(r));
    await script({ client, turnCompleted, compactionCompleted, serverRequests });
    await deadline(client.close(), 30_000, 'the client closing');
    client = null;
    const stopping = new AbortController();
    const stopped = await deadline(
      fetch(`http://127.0.0.1:${doc.core.control.port}/mgmt/stop`, { method: 'POST', headers: { authorization: `Bearer ${doc.endpoints.session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'whenIdle', reason: 'quit' }), signal: stopping.signal }),
      30_000,
      'the core answering /mgmt/stop',
    ).finally(() => stopping.abort());
    if (!stopped.ok) throw new Error(`/mgmt/stop answered ${stopped.status}`);
    await deadline(exited, 60_000, 'the core exiting');
    return serverRequests;
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch {}
    }
    if (client) {
      try { await deadline(client.close(), 30_000, 'the client closing'); } catch {}
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await deadline(exited, 30_000, "the core's job host ending after its kill");
    }
  }
}

/** The text a provider call carried, per message: role, content text and tool-call arguments (the two runtimes' wire forms
 *  differ; the text is what must match). Node's `sends` are its internal messages, the core's are OpenAI-chat bodies. */
function nodeText(messages) {
  return messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    text: typeof m.content === 'string' ? m.content : (m.content ?? []).map((part) => part.text ?? '').join(''),
    calls: (m.toolCalls ?? []).map((c) => (typeof c.arguments === 'string' ? JSON.parse(c.arguments) : c.arguments)),
  }));
}
function coreText(body) {
  return body.messages.filter((m) => m.role !== 'system' && m.role !== 'developer').map((m) => ({
    role: m.role,
    text: typeof m.content === 'string' ? m.content : (m.content ?? []).map((part) => part.text ?? '').join(''),
    calls: (m.tool_calls ?? []).map((c) => JSON.parse(c.function.arguments)),
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bin = resolve(arg('--mixdogd'));
  if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent (the workspace path is part of the files)');
  const base = mkdtempSync(join(scratch, 'sw-rpl-'));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  const profile = join(base, 'profile');
  const p = { root: base, profile, home: join(profile, 'home'), mixdogHome: join(profile, 'home', '.mixdog'), data: join(profile, 'home', '.mixdog', 'data'), runtime: join(profile, 'runtime'), appData: join(profile, 'home', 'AppData', 'Roaming'), local: join(profile, 'home', 'AppData', 'Local'), tmp: join(profile, 'tmp') };
  for (const d of [p.data, p.runtime, p.appData, p.local, p.tmp, join(base, 'bin')]) mkdirSync(d, { recursive: true });
  p.exe = join(base, 'bin', 'mixdogd.exe');
  copyFileSync(bin, p.exe);
  writeFileSync(join(base, 'bin', 'js-runtime.json'), JSON.stringify({ program: process.execPath, packageRoot: repo }));
  const requests = [];
  const prov = await provider(requests);
  writeFileSync(join(p.data, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { [CUSTOM]: { type: 'custom', name: 'sw', protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: MODEL }] } } } }));
  const log = join(base, 'core.log');
  let bad = 0;
  let threadId = null;
  try {
    const first = await runCore(p, bin, log, async ({ client, turnCompleted, compactionCompleted }) => {
      const started = await deadline(client.call('thread/start', { kind: 'task', session: { toolMode: 'full', autoWakeCompletions: false, webSearch: false, memory: false }, projectPath: ws, draft: { projectPath: ws, route: { provider: CUSTOM, model: MODEL }, orchestrationMode: 'none' } }), 60_000, 'thread/start');
      threadId = started.thread.id;
      await deadline(client.resumeThread(threadId, { lastItems: 10 }), 30_000, 'thread/resume');
      for (const turn of TURNS.filter((t) => t.phase === 1)) {
        const done = turnCompleted();
        await deadline(client.call('turn/start', { threadId, input: { prompt: turn.prompt, options: {} } }), 60_000, 'turn/start');
        await deadline(done, 120_000, `the turn "${turn.prompt}"`);
      }
      const compacted = compactionCompleted();
      await deadline(client.call('thread/compact/start', { threadId, opId: 'op-compact' }), 60_000, 'thread/compact/start');
      console.log(`the compaction: ${JSON.stringify(await deadline(compacted, 60_000, 'the compaction'))}`);
    });
    const second = await runCore(p, bin, log, async ({ client, turnCompleted }) => {
      await deadline(client.resumeThread(threadId, { lastItems: 10 }), 30_000, 'thread/resume after the reload');
      for (const turn of TURNS.filter((t) => t.phase === 2)) {
        const done = turnCompleted();
        await deadline(client.call('turn/start', { threadId, input: { prompt: turn.prompt, options: {} } }), 60_000, 'turn/start');
        await deadline(done, 120_000, `the turn "${turn.prompt}"`);
      }
    });
    writeFileSync(join(base, 'server-requests.json'), JSON.stringify([first, second], null, 1));
    writeFileSync(join(base, 'requests.json'), JSON.stringify(requests, null, 1));
    // 1. No file the cores wrote holds a value, in any spelling.
    const hits = scanSecrets(profile, [CODE, FAILED, SECRET]);
    for (const hit of hits) console.log(`HIT ${hit.file}@${hit.offset} (${hit.encoding} of ${hit.value})`);
    bad += hits.length;
    // 2. The model input per provider call, against Node's.
    if (requests.length !== golden.sends.length) {
      bad += 1;
      console.log(`DIFF provider calls: the core made ${requests.length}, Node ${golden.sends.length}`);
    }
    for (let i = 0; i < Math.min(requests.length, golden.sends.length); i += 1) {
      const node = JSON.stringify(nodeText(golden.sends[i].messages));
      const core = JSON.stringify(coreText(requests[i]));
      if (node !== core) {
        bad += 1;
        console.log(`DIFF model input of call ${i}\n   core: ${core}\n   node: ${node}`);
      } else console.log(`SAME model input of call ${i}`);
    }
    // 3. The files both runtimes write in the same format, whole after the same normalisation.
    const normalized = normalizeTree(profile, { sessionId: threadId, workspace: ws });
    const coreFiles = Object.keys(normalized.files);
    writeFileSync(join(base, 'files.json'), JSON.stringify(normalized.files, null, 1));
    console.log(`the cores wrote ${coreFiles.length} files:\n  ${coreFiles.join('\n  ')}`);
    for (const [name, want] of Object.entries(golden.files)) {
      if (typeof want !== 'string') continue;
      const core = coreFiles.find((file) => file.endsWith(name.replace(/^mixdog_data_dir\//, '.mixdog/data/')));
      if (!core) {
        console.log(`NODE-ONLY ${name}`);
        continue;
      }
      const got = normalized.files[core];
      console.log(`${got === want ? 'SAME' : 'DIFF'} ${name}`);
      if (got !== want) {
        bad += 1;
        let at = 0;
        while (got[at] === want[at]) at += 1;
        console.log(`   core: ${String(got).slice(Math.max(0, at - 200), at + 200)}\n   node: ${want.slice(Math.max(0, at - 200), at + 200)}`);
      }
    }
  } finally {
    await prov.close();
  }
  console.log(`the run's folder ${base} is kept${bad ? '' : ' (removing)'}`);
  if (!bad) rmSync(base, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
}
