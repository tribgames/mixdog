#!/usr/bin/env node
// Drives a built `mixdogd` through the scenarios of native/core/fixtures/tool-failures/golden.json (one core per scenario, an
// isolated profile, a scripted OpenAI-chat provider) and compares the bytes of its history/tool-failures.jsonl with Node's
// recording, in order, replacing only the values the golden names as varying (session_id by first-seen order, ts, tool_ms).
//   node replay-tool-failures.mjs --mixdogd <exe> [--only <n>,<n>]
// Scenarios that need a hook or an approval answer are not driven yet and are listed as skipped; the exit code is 1 on any difference.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..', '..');
const golden = JSON.parse(readFileSync(join(repo, 'native/core/fixtures/tool-failures/golden.json'), 'utf8'));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const bin = resolve(arg('--mixdogd'));
const only = arg('--only', null)?.split(',').map(Number);
const scratch = process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir();
const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
const CUSTOM = 'custom-11111111-1111-4111-8111-111111111111';
const deadline = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`${what} did not finish within ${ms} ms`)), ms).unref())]);

const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
  res.end();
};
const chunk = (delta, finish = null) => ({ id: 's', object: 'chat.completion.chunk', created: 0, model: golden.model, choices: [{ index: 0, delta, finish_reason: finish }] });

function provider(replies) {
  let n = 0;
  let done;
  const finished = new Promise((r) => (done = r));
  const server = createServer((req, res) => {
    const body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', () => {
      if (process.env.REPLAY_DEBUG && req.method === 'POST') {
        const msgs = JSON.parse(Buffer.concat(body).toString('utf8')).messages ?? [];
        console.log('REQ', n, JSON.stringify(msgs.filter((m) => m.role === 'tool').map((m) => String(m.content).slice(0, 160))));
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: golden.model, object: 'model' }] }));
      }
      const step = replies[n++];
      if (!step) return sse(res, [chunk({ role: 'assistant', content: 'extra' }), chunk({}, 'stop'), '[DONE]']);
      if (!step.calls.length) {
        sse(res, [chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop'), '[DONE]']);
        return done();
      }
      const tool_calls = step.calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args) } }));
      sse(res, [chunk({ role: 'assistant', tool_calls }), chunk({}, 'tool_calls'), '[DONE]']);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ baseURL: `http://127.0.0.1:${server.address().port}`, finished, close: () => new Promise((c) => { server.closeAllConnections(); server.close(c); }) })));
}

let libs;
async function loadLibs() {
  libs ??= (async () => {
    register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) { return s === '@mixdog/protocol' ? { url: ${JSON.stringify(pathToFileURL(join(repo, 'packages/protocol/src/index.ts')).href)}, shortCircuit: true } : next(s, c); }`)}`);
    return { ws: (await import('ws')).default, client: await import(pathToFileURL(join(repo, 'packages/protocol-client/src/index.ts')).href) };
  })();
  return libs;
}

async function runScenario(scenario) {
  const root = mkdtempSync(join(scratch, 'replay-tf-'));
  const home = join(root, 'home');
  const p = { data: join(home, '.mixdog', 'data'), runtime: join(root, 'runtime'), appData: join(home, 'AppData', 'Roaming'), local: join(home, 'AppData', 'Local'), tmp: join(root, 'tmp'), bin: join(root, 'bin') };
  for (const d of Object.values(p)) mkdirSync(d, { recursive: true });
  const ws = golden.workspace;
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  for (const [name, text] of Object.entries(golden.files)) writeFileSync(join(ws, name), text);
  const prov = await provider(scenario.replies);
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
  const child = spawn(exe, ['serve'], { env, cwd: root, stdio: 'ignore', windowsHide: true });
  const exited = new Promise((r) => child.once('exit', r));
  let client;
  try {
    const doc = await deadline(new Promise((res, rej) => {
      const file = join(p.runtime, 'daemon.json');
      const check = () => { try { const d = JSON.parse(readFileSync(file, 'utf8')); if (d.core?.state === 'blocked') rej(new Error('core blocked')); if (d.core?.state === 'serving' && d.core.rpc?.port) { w.close(); res(d); } } catch {} };
      const w = watch(p.runtime, check);
      check();
    }), 120_000, 'the core serving');
    const { ws: WebSocket, client: lib } = await loadLibs();
    client = await lib.connect({
      target: { id: 'local' },
      connector: { async open(_t, sink) {
        const socket = new WebSocket(`ws://127.0.0.1:${doc.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${doc.endpoints.session.token}` }, perMessageDeflate: false });
        return new Promise((res, rej) => {
          socket.on('open', () => res({ send: (t) => socket.send(t), close: (c, r) => socket.close(c, r) }));
          socket.on('message', (d) => sink.frame(d.toString('utf8')));
          socket.on('close', (c, r) => sink.closed(c, r.toString('utf8')));
          socket.on('error', rej);
        });
      } },
      clientInfo: { name: 'tf-replay', title: 'tf-replay', version: String(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version), kind: 'tui' },
      capabilities: {},
      threadReducer: lib.sessionReducer,
      clock: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      random: Math.random,
    });
    // The approval answer the scenario scripts, given to every approval request the core holds.
    client.on((event) => {
      if (event.type !== 'serverRequest' || event.request.method !== 'item/tool/requestApproval') return;
      const a = scenario.approval;
      client.respond(event.request.id, { result: { approved: a.approved, response: a.approved ? 'approve' : 'deny', reason: a.reason } });
    });
    // `approvalMode: "implicit"` is a session with no approval surface; the approval scenario needs the client to be one.
    const session = scenario.full
      ? { toolMode: 'full', approvalMode: 'implicit', autoWakeCompletions: false, webSearch: false, memory: false }
      : { toolProfile: 'headless', toolMode: 'full', ...(scenario.approval ? {} : { approvalMode: 'implicit' }), disallowDelegation: true, autoWakeCompletions: false, webSearch: false, memory: false };
    const started = await deadline(client.call('thread/start', { kind: 'task', session, projectPath: ws, draft: { projectPath: ws, route: { provider: CUSTOM, model: golden.model }, ...(scenario.full ? {} : { workflowId: 'headless' }), orchestrationMode: 'none' } }), 60_000, 'thread/start');
    const threadId = started.thread.id;
    const turn = await deadline(client.call('turn/start', { threadId, input: { prompt: 'go', options: {} } }), 60_000, 'turn/start');
    if (scenario.abortWhenFile) {
      await deadline(new Promise((res) => { const w = watch(ws, (_e, f) => { if (f === scenario.abortWhenFile) { w.close(); res(); } }); }), 60_000, 'the tool starting');
      await client.call('turn/interrupt', { threadId, turnId: turn.turnId });
      await new Promise((r) => setTimeout(r, 0));
    } else {
      await deadline(prov.finished, 120_000, 'the scripted turn reaching its final reply');
    }
    await client.close();
    client = null;
    const res = await fetch(`http://127.0.0.1:${doc.core.control.port}/mgmt/stop`, { method: 'POST', headers: { authorization: `Bearer ${doc.endpoints.session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'whenIdle', reason: 'quit' }) });
    if (!res.ok) throw new Error(`/mgmt/stop ${res.status}`);
    await deadline(exited, 30_000, 'the core exiting');
    const file = join(p.data, 'history', 'tool-failures.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  } finally {
    try { await client?.close(); } catch {}
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await prov.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** Rows with the varying values replaced: session ids by first-seen order, ts and tool_ms by their type. */
export function normalize(text) {
  const ids = new Map();
  return text.split('\n').filter(Boolean).map((line) => {
    const row = JSON.parse(line);
    if (!Number.isInteger(row.ts) || !Number.isInteger(row.tool_ms) || row.tool_ms < 0) throw new Error(`bad ts/tool_ms in ${line}`);
    if (!ids.has(row.session_id)) ids.set(row.session_id, `<session:${ids.size + 1}>`);
    return line.replace(`"ts":${row.ts}`, '"ts":"<ts>"').replace(`"session_id":${JSON.stringify(row.session_id)}`, `"session_id":"${ids.get(row.session_id)}"`).replace(`"tool_ms":${row.tool_ms}`, '"tool_ms":"<ms>"');
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Node's rows per scenario: one recording holds all scenarios' rows in order, so the expected rows are cut by scenario via the session ids.
  const nodeRows = golden.recordings[0].file.split('\n').filter(Boolean);
  const bySession = new Map();
  for (const line of nodeRows) {
    const id = JSON.parse(line).session_id;
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(line);
  }
  const expectedOf = (i) => bySession.get(golden.recordings[0].sessions[i]) ?? [];
  let bad = 0;
  for (const [i, scenario] of golden.scenarios.entries()) {
    if (only && !only.includes(i)) continue;
    const got = normalize(await runScenario(scenario));
    const want = normalize(expectedOf(i).join('\n'));
    const same = got.length === want.length && got.every((l, k) => l === want[k]);
    console.log(`${same ? 'SAME' : 'DIFF'} ${i} ${scenario.name} (${got.length} rows, Node ${want.length})`);
    if (!same) {
      bad += 1;
      for (let k = 0; k < Math.max(got.length, want.length); k += 1) if (got[k] !== want[k]) console.log(`  row ${k}\n   core: ${got[k]}\n   node: ${want[k]}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
