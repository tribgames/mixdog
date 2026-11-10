// Drives a RUNNING mixdogd through the Stops of remote-protocol-chat-abort-cases.mjs, case for case as Node's recording
// (remote-protocol-chat-abort.record.mjs) drove its daemon, and returns what the core answered. The test
// (remote-protocol-chat-abort-live.test.mjs) runs it each time and compares it with Node's recording. Each case is a fresh thread; the phone's calls are recorded as the core got them (`turn/start`,
// `turn/interrupt`) with the core's whole reply, then the thread's items and its list row once the turn(s) closed.
//
// The binary is `MIXDOGD_EXE`, the real-turn harness directory `REAL_TURN_HARNESS`: a missing one fails. Every wait is an event wait under
// one deadline that names what it waits for; nothing is retried; everything started is ended on every path.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { uuidv7 } from '../../../../packages/protocol-client/src/client.ts';
import { ABORT_CASES, DEVICES, PROJECT_FILE } from './remote-protocol-chat-abort-cases.mjs';
import { startAbortProvider } from './remote-protocol-chat-abort-provider.mjs';

/**
 * Ends the memory cluster the killed core left running. The harness's `killStrayPostgres` matches the pgdata path with backslashes, but
 * pg_ctl starts postgres with the path in forward slashes, so it matched nothing and the next run's folder removal hit EBUSY on pg.log.
 */
function killCluster(dataDir) {
  const pgdata = join(dataDir, 'pgdata');
  const forms = [pgdata, pgdata.replaceAll('\\', '/')].map((p) => `'*${p.replace(/'/g, "''")}*'`).join(', ');
  const script = `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object { $c = $_.CommandLine; @(${forms}) | Where-Object { $c -like $_ } } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 60_000 });
  if (out.status !== 0) throw new Error(`ending the memory cluster under ${pgdata} failed (${out.status ?? out.error}): ${out.stderr}`);
}

/** `only` names one case of ABORT_CASES to run alone; without it every case runs (what the test's full run compares). */
export async function runAbortLive({ only } = {}) {
  const chosen = only === undefined ? ABORT_CASES : ABORT_CASES.filter((c) => c.name === only);
  if (!chosen.length) throw new Error(`--only names no abort case: ${JSON.stringify(only)}`);
  const bin = process.env.MIXDOGD_EXE;
  const harness = process.env.REAL_TURN_HARNESS;
  if (!bin || !existsSync(bin)) throw new Error(`MIXDOGD_EXE must name the built mixdogd binary (got ${JSON.stringify(bin)})`);
  if (!harness || !existsSync(join(harness, 'lib', 'env.mjs'))) throw new Error(`REAL_TURN_HARNESS must name the real-turn harness directory (got ${JSON.stringify(harness)})`);
  process.env.HARNESS_ENV_ROOT = join(harness, 'run', 'env-ph2-chat-abort-live');
  const load = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
  const { daemonEnv, isolatedPaths } = await load('env.mjs');
  const { seedPgRuntime } = await load('stage.mjs');
  const { launch } = await load('proc.mjs');
  const { createDeadline, latch } = await load('deadline.mjs');

  const paths = isolatedPaths();
  rmSync(paths.envRoot, { recursive: true, force: true });
  for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
  const project = join(paths.workspace, 'a');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, PROJECT_FILE.name), PROJECT_FILE.text);
  seedPgRuntime(paths.dataDir);

  const notes = [];
  let core;
  const sockets = [];
  let watcher;
  let provider;
  let deadline = createDeadline(240_000, () => `${core?.tail() ?? '(core not started)'}\nnotifications: ${notes.slice(-12).map((n) => n.method).join(', ')}`);
  try {
    provider = await deadline.race(startAbortProvider(), 'the model endpoint to listen');
    writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
    const route = { provider: 'custom-harness', model: 'harness-model' };

    core = launch(bin, ['serve'], { env: daemonEnv(paths, { RUST_LOG: 'warn' }), cwd: paths.envRoot });
    const daemonDoc = () => {
      const file = join(paths.runtimeRoot, 'daemon.json');
      if (!existsSync(file)) return null;
      try {
        const d = JSON.parse(readFileSync(file, 'utf8'));
        return d?.core?.state === 'serving' && d.core.rpc?.port ? d : null;
      } catch { return null; }
    };
    const served = latch();
    watcher = watch(paths.runtimeRoot, () => { const d = daemonDoc(); if (d) served.resolve(d); });
    const early = daemonDoc();
    if (early) served.resolve(early);
    const doc = await deadline.race(served.promise, 'the core to serve');

    // One connection per paired device: the core stamps a prompt and a Stop with the connection's `clientInfo.title` (server.rs initialize).
    const waiters = new Set();
    const connect = async (title) => {
      const ws = new WebSocket(`ws://127.0.0.1:${doc.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${doc.endpoints.session.token}` }, perMessageDeflate: false });
      sockets.push(ws);
      await deadline.race(new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }), `the app-server socket of ${title} to open`);
      const pending = new Map();
      let nextId = 1;
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8'));
        if (frame.id !== undefined && pending.has(frame.id)) {
          const p = pending.get(frame.id);
          pending.delete(frame.id);
          if (frame.error) p.reject(Object.assign(new Error(`${p.method}: ${JSON.stringify(frame.error)}`), { rpc: frame.error })); else p.resolve(frame.result);
        } else if (frame.method) {
          notes.push({ method: frame.method, params: frame.params, device: title });
          for (const check of [...waiters]) check();
        }
      });
      const call = (method, params) => deadline.race(new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
      }), `the reply of ${title} to ${method}`);
      const op = (method, params) => call(method, { ...params, opId: uuidv7(Date.now()) });
      await call('initialize', { clientInfo: { name: 'ph2-chat-abort', title, version: '1.4.5', kind: 'tui' }, capabilities: {} });
      ws.send(JSON.stringify({ method: 'initialized' }));
      await call('app/subscribe', {});
      return { call, op };
    };
    const until = (ready, what) => {
      const done = latch();
      const check = () => { if (ready()) { waiters.delete(check); done.resolve(); } };
      waiters.add(check);
      check();
      return deadline.race(done.promise, what);
    };
    // What the submitting device's connection was told (it holds the thread open); the other device only sends its Stop.
    let viewer = '';
    const seen = (id, method, text) => notes.filter((n) => n.device === viewer && n.method === method && n.params?.threadId === id && (text === undefined || JSON.stringify(n.params).includes(text))).length;
    const phones = new Map();
    const phone = async (title) => {
      if (!phones.has(title)) phones.set(title, await connect(title));
      return phones.get(title);
    };

    const cases = [];
    for (const c of chosen) {
      const submitter = await phone(c.submitter ?? DEVICES.a);
      const canceller = await phone(c.canceller ?? c.submitter ?? DEVICES.a);
      const mark = notes.length;
      viewer = c.submitter ?? DEVICES.a;
      // The phone's submitNewTask: a thread with the draft route, then the first prompt (service-route.ts submitNewTask / turnInput).
      const id = (await submitter.op('thread/start', { kind: 'project', projectPath: project, draft: { route } })).thread.id;
      await submitter.call('thread/resume', { threadId: id, window: { lastItems: 200 } });
      const options = { clientSubmissionId: `sub-${c.name}`, ...(c.pasted ? { pastedTexts: c.pasted } : {}), ...(c.submit ?? {}) };
      const start = { threadId: id, input: { prompt: c.prompt, options } };
      await submitter.op('turn/start', start);
      const completed = (count) => seen(id, 'turn/completed') >= count;
      if (c.ready === 'completed') await until(() => completed(1), `the turn of ${c.name} to end on its own`);
      else if (c.ready === 'approval') {
        await deadline.race(provider.asked(c.prompt), `the model endpoint to receive the tool-calling turn of ${c.name}`);
        // As Node's recording waits: the question is pending and the call's card is shown.
        const pending = () => notes.some((n) => n.device === viewer && /^item\/tool\/request(Approval|UserInput)$/.test(n.method) && n.params?.threadId === id);
        const card = () => notes.some((n) => n.device === viewer && /^item\/(started|completed)$/.test(n.method) && n.params?.threadId === id && n.params?.item?.type === 'toolCall');
        await until(() => pending() && card(), `the tool approval of ${c.name} to be pending with its card shown`);
      } else await deadline.race(provider.held(c.prompt), `the model endpoint to receive the held turn of ${c.name}`);
      if (c.output) await until(() => seen(id, 'item/agentMessage/delta', c.output) > 0, `the streamed text of ${c.name} to reach the client`);
      let second;
      if (c.then) {
        second = { threadId: id, input: { prompt: c.then, options: { clientSubmissionId: `sub-${c.name}-2` } } };
        await submitter.op('turn/start', second);
      }
      const stop = { threadId: id, ...c.stop };
      const reply = await canceller.call('turn/interrupt', stop).catch((error) => ({ error: error.rpc }));
      // A stopped turn closes with turn/completed; a steering prompt then runs as the next turn.
      await until(() => completed(c.then ? 2 : 1), `the turn(s) of ${c.name} to complete after its Stop`);
      let again;
      if (c.again) {
        const request = { threadId: id, ...c.again };
        again = { request, reply: await canceller.call('turn/interrupt', request).catch((error) => ({ error: error.rpc })) };
      }
      // What the stopped turn left, whole, read at the same moment on both surfaces the phone reads: the thread's items and its list row.
      const read = await submitter.call('thread/read', { threadId: id, window: { lastItems: 200 } });
      const row = (await submitter.call('thread/list', { limit: 1000 })).data.find((r) => r.id === id) ?? null;
      // What the composer of the device that sent the prompt is told (`thread/promptRestore`, the session state's `promptRestore`).
      const restores = notes.slice(mark).filter((n) => n.method === 'thread/promptRestore' && n.params?.threadId === id && n.device === (c.submitter ?? DEVICES.a)).map((n) => n.params);
      cases.push({ name: c.name, start, ...(second ? { second } : {}), stop, core: { reply, ...(again ? { again } : {}), items: read.items, row, promptRestores: restores } });
    }    return {
      manifest: {
        binary: bin, binarySha256: createHash('sha256').update(readFileSync(bin)).digest('hex'), binaryBuilt: statSync(bin).mtime.toISOString(),
        source: 'running mixdogd serve, isolated env (real-turn harness env.mjs / stage.mjs / proc.mjs), model endpoint remote-protocol-chat-abort-provider.mjs, driven over the WebSocket JSON-RPC protocol',
      },
      cases,
    };
  } finally {
    deadline.clear();
    const ended = createDeadline(60_000, () => `ending the abort run; core: ${core?.tail()}`);
    try {
      watcher?.close();
      for (const ws of sockets) ws.close();
      try {
        if (core) {
          core.kill();
          await ended.race(core.exited, 'the core to exit');
        }
      } finally {
        try {
          if (provider) await ended.race(provider.close(), 'the model endpoint to close');
        } finally {
          killCluster(paths.dataDir);
        }
      }
    } finally {
      ended.clear();
    }
  }
}
