#!/usr/bin/env node
// Drives a built `mixdogd` through the scenarios of native/core/fixtures/tool-failures/golden.json (one core per scenario, an
// isolated profile, a scripted OpenAI-chat provider) and compares the bytes of the history/tool-failures.jsonl the cores wrote with
// Node's recording, as one sequence in scenario order, replacing only the values the golden names as varying (session_id by first-seen
// order, ts, tool_ms) and the workspace path by a placeholder (each run has its own folder; the recorded path's length is the same).
//   node replay-tool-failures.mjs --mixdogd <exe> [--only <n>,<n>]
// A scenario the golden marks `coreDiffers` is run and reported, and left out of the sequence verdict (its Node rows are the rows of its
// recorded sessions). The exit code is 1 on any difference.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILES, scenarios } from './lib/tool-failure-scenarios.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..', '..');
const golden = JSON.parse(readFileSync(join(repo, 'native/core/fixtures/tool-failures/golden.json'), 'utf8'));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const only = arg('--only', null)?.split(',').map(Number);
const scratch = process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir();
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
  let done;
  const finished = new Promise((r) => (done = r));
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

/** The processes whose command line names `folder`, other than the lister itself. */
function processesNaming(folder) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${folder.replace(/'/g, "''")}*' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  const listed = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30_000 });
  if (listed.status !== 0) throw new Error(`listing the processes that name ${folder} failed (${listed.status ?? listed.signal}): ${listed.stderr}`);
  return listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Runs one scenario on a fresh core and returns the file it wrote. `root` is this scenario's folder under the run's folder. */
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
    const prov = await provider(scenario.replies);
    cleanups.push(() => prov.close());
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
    child = spawn(exe, ['serve'], { env, cwd: root, stdio: ['ignore', 'ignore', stderrFile], windowsHide: true });
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
      // The client sleeps only to back off before a reconnect; this replay has none, so a use of the clock is a failure.
      clock: { sleep: (ms) => Promise.reject(new Error(`the client asked to sleep ${ms} ms (a reconnect backoff): the connection was lost`)) },
      random: Math.random,
    });
    // The approval answer the scenario scripts, given to every approval request the core holds.
    cleanups.push(client.on((event) => {
      if (event.type !== 'serverRequest' || event.request.method !== 'item/tool/requestApproval') return;
      const a = scenario.approval;
      client.respond(event.request.id, { result: { approved: a.approved, response: a.approved ? 'approve' : 'deny', reason: a.reason } });
    }));
    // The turn's end is the core's own `turn/completed` notification.
    let turnCompleted;
    const completed = new Promise((r) => { turnCompleted = r; });
    cleanups.push(client.on((event) => { if (event.type === 'notification' && event.notification.method === 'turn/completed') turnCompleted(); }));
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
      await deadline(prov.finished, 120_000, 'the scripted turn reaching its final reply');
    }
    await client.close();
    client = null;
    const stopped = await fetch(`http://127.0.0.1:${doc.core.control.port}/mgmt/stop`, { method: 'POST', headers: { authorization: `Bearer ${doc.endpoints.session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'whenIdle', reason: 'quit' }), signal: AbortSignal.timeout(30_000) });
    if (!stopped.ok) throw new Error(`/mgmt/stop answered ${stopped.status}`);
    await deadline(exited, 30_000, 'the core exiting');
    const file = join(p.data, 'history', 'tool-failures.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  } finally {
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch {} }
    try { await client?.close(); } catch {}
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await deadline(exited, 30_000, 'the core ending after its kill');
    }
  }
}

/** The workspace path (as written in JSON strings, either separator) becomes a placeholder; the placeholder is the same on both sides. */
function maskWorkspace(text, workspace) {
  const forms = new Set([workspace, workspace.replaceAll('\\', '/')].flatMap((w) => [w, w.replaceAll('\\', '\\\\')]));
  let masked = text;
  for (const form of forms) masked = masked.replaceAll(form, '<WS>');
  return masked;
}

/** Rows with the varying values replaced: session ids by first-seen order, ts and tool_ms by their type. The text is a whole file: every line a row. */
export function normalize(text, workspace) {
  if (text !== '' && !text.endsWith('\n')) throw new Error('the file does not end with a newline');
  const ids = new Map();
  return (text === '' ? [] : text.slice(0, -1).split('\n')).map((line) => {
    const row = JSON.parse(line);
    if (!Number.isInteger(row.ts) || !Number.isInteger(row.tool_ms) || row.tool_ms < 0) throw new Error(`bad ts/tool_ms in ${line}`);
    if (!ids.has(row.session_id)) ids.set(row.session_id, `<session:${ids.size + 1}>`);
    return maskWorkspace(line.replace(`"ts":${row.ts}`, '"ts":"<ts>"').replace(`"session_id":${JSON.stringify(row.session_id)}`, `"session_id":"${ids.get(row.session_id)}"`).replace(`"tool_ms":${row.tool_ms}`, '"tool_ms":"<ms>"'), workspace);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bin = resolve(arg('--mixdogd'));
  const base = mkdtempSync(join(scratch, 'tf-replay-'));
  let bad = 0;
  let ws;
  try {    // The recorded workspace's length is part of the rows (a cut lands inside an emoji at a fixed length), so this run's folder must have it.
    ws = mkdtempSync(join(scratch, 'tf-ws-'));
    if (ws.length !== golden.workspace.length) throw new Error(`the workspace ${ws} is ${ws.length} characters, the recorded ${golden.workspace} ${golden.workspace.length}: use the recorder's scratch folder (MIXDOG_RECORDER_SCRATCH)`);
    if (JSON.stringify(scenarios(ws)) !== JSON.stringify(golden.scenarios)) throw new Error('the scenarios built for this workspace are not the recorded ones');
    const ran = [];
    for (const [i, scenario] of golden.scenarios.entries()) {
      if (only && !only.includes(i)) continue;
      ran.push({ i, scenario, text: await runScenario(scenario, join(base, `s${i}`), ws, bin) });
    }
    // Node's file is one sequence over all scenarios; the cores' files are joined in scenario order and compared as that one sequence.
    const nodeText = golden.recordings[0].file;
    const nodeIds = golden.recordings[0].sessions;
    const kept = (i) => !golden.scenarios[i].coreDiffers;
    const dropped = new Set(golden.scenarios.flatMap((s, i) => (kept(i) ? [] : [nodeIds[i]])));
    const nodeLines = nodeText.slice(0, -1).split('\n').filter((line) => !dropped.has(JSON.parse(line).session_id));
    const wantedScenarios = ran.filter(({ i }) => kept(i));
    const got = normalize(wantedScenarios.map((r) => r.text).join(''), ws);
    const want = normalize(`${nodeLines.join('\n')}\n`, golden.workspace);
    const same = got.length === want.length && got.every((line, k) => line === want[k]);
    console.log(`${same ? 'SAME' : 'DIFF'} the sequence of ${wantedScenarios.length} scenarios (${got.length} rows, Node ${want.length})`);
    if (!same) {
      bad += 1;
      for (let k = 0; k < Math.max(got.length, want.length); k += 1) if (got[k] !== want[k]) console.log(`  row ${k}\n   core: ${got[k]}\n   node: ${want[k]}`);
    }
    for (const { i, scenario, text } of ran) {
      const rows = text === '' ? 0 : text.split('\n').length - 1;
      console.log(`  ${i} ${scenario.name}: ${rows} rows${scenario.coreDiffers ? ` [left out of the verdict: ${scenario.coreDiffers}]` : ''}`);
    }
  } finally {
    if (ws) rmSync(ws, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
    const left = processesNaming(base);
    if (left.length) { console.log(`processes still naming ${base}: ${left.join(', ')}`); bad += 1; }
  }
  process.exit(bad ? 1 : 0);
}