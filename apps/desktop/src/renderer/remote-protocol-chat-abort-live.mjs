// Drives a RUNNING mixdogd through the Stops of remote-protocol-chat-abort-cases.mjs, case for case as Node's recording
// (remote-protocol-chat-abort.record.mjs) drove its daemon, and returns what the core answered. The test
// (remote-protocol-chat-abort-live.test.mjs) runs it each time and compares it with Node's recording. Each case is a fresh thread; the phone's calls are recorded as the core got them (`turn/start`,
// `turn/interrupt`) with the core's whole reply, then the thread's items and its list row once the turn(s) closed.
//
// The binary is `MIXDOGD_EXE`, the real-turn harness directory `REAL_TURN_HARNESS`: a missing one fails. Every wait is an event wait under
// one deadline that names what it waits for; nothing is retried; everything started is ended on every path.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { uuidv7 } from '../../../../packages/protocol-client/src/client.ts';
import { ABORT_CASES } from './remote-protocol-chat-abort-cases.mjs';
import { startAbortProvider } from './remote-protocol-chat-abort-provider.mjs';

export async function runAbortLive() {
  const bin = process.env.MIXDOGD_EXE;
  const harness = process.env.REAL_TURN_HARNESS;
  if (!bin || !existsSync(bin)) throw new Error(`MIXDOGD_EXE must name the built mixdogd binary (got ${JSON.stringify(bin)})`);
  if (!harness || !existsSync(join(harness, 'lib', 'env.mjs'))) throw new Error(`REAL_TURN_HARNESS must name the real-turn harness directory (got ${JSON.stringify(harness)})`);
  process.env.HARNESS_ENV_ROOT = join(harness, 'run', 'env-ph2-chat-abort-live');
  const load = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
  const { daemonEnv, isolatedPaths } = await load('env.mjs');
  const { seedPgRuntime, killStrayPostgres } = await load('stage.mjs');
  const { launch } = await load('proc.mjs');
  const { createDeadline, latch } = await load('deadline.mjs');

  const paths = isolatedPaths();
  rmSync(paths.envRoot, { recursive: true, force: true });
  for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
  const project = join(paths.workspace, 'a');
  mkdirSync(project, { recursive: true });
  seedPgRuntime(paths.dataDir);

  const notes = [];
  let core;
  let socket;
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

    socket = new WebSocket(`ws://127.0.0.1:${doc.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${doc.endpoints.session.token}` }, perMessageDeflate: false });
    await deadline.race(new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }), 'the app-server socket to open');
    const pending = new Map();
    const waiters = new Set();
    let nextId = 1;
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8'));
      if (frame.id !== undefined && pending.has(frame.id)) {
        const p = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.error) p.reject(Object.assign(new Error(`${p.method}: ${JSON.stringify(frame.error)}`), { rpc: frame.error })); else p.resolve(frame.result);
      } else if (frame.method) {
        notes.push({ method: frame.method, params: frame.params });
        for (const check of [...waiters]) check();
      }
    });
    const call = (method, params) => deadline.race(new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      socket.send(JSON.stringify({ id, method, params }));
    }), `the reply to ${method}`);
    const op = (method, params) => call(method, { ...params, opId: uuidv7(Date.now()) });
    const until = (ready, what) => {
      const done = latch();
      const check = () => { if (ready()) { waiters.delete(check); done.resolve(); } };
      waiters.add(check);
      check();
      return deadline.race(done.promise, what);
    };
    const seen = (id, method, text) => notes.filter((n) => n.method === method && n.params?.threadId === id && (text === undefined || JSON.stringify(n.params).includes(text))).length;

    await call('initialize', { clientInfo: { name: 'ph2-chat-abort', title: 'PH-2 abort', version: '1.4.5', kind: 'tui' }, capabilities: {} });
    socket.send(JSON.stringify({ method: 'initialized' }));
    await call('app/subscribe', {});
    const cases = [];
    for (const c of ABORT_CASES) {
      // The phone's submitNewTask: a thread with the draft route, then the first prompt (service-route.ts submitNewTask / turnInput).
      const id = (await op('thread/start', { kind: 'project', projectPath: project, draft: { route } })).thread.id;
      await call('thread/resume', { threadId: id, window: { lastItems: 200 } });
      const options = { clientSubmissionId: `sub-${c.name}`, ...(c.pasted ? { pastedTexts: c.pasted } : {}) };
      const start = { threadId: id, input: { prompt: c.prompt, options } };
      await op('turn/start', start);
      await deadline.race(provider.held(c.prompt), `the model endpoint to receive the held turn of ${c.name}`);
      if (c.output) await until(() => seen(id, 'item/agentMessage/delta', c.output) > 0, `the streamed text of ${c.name} to reach the client`);
      let second;
      if (c.then) {
        second = { threadId: id, input: { prompt: c.then, options: { clientSubmissionId: `sub-${c.name}-2` } } };
        await op('turn/start', second);
      }
      const stop = { threadId: id, ...c.stop };
      const reply = await call('turn/interrupt', stop);
      // A stopped turn closes with turn/completed; a steering prompt then runs as the next turn.
      await until(() => seen(id, 'turn/completed') >= (c.then ? 2 : 1), `the turn(s) of ${c.name} to complete after its Stop`);
      let again;
      if (c.again) {
        const request = { threadId: id, ...c.again };
        again = { request, reply: await call('turn/interrupt', request).catch((error) => ({ error: error.rpc })) };
      }
      // What the stopped turn left, whole, read at the same moment on both surfaces the phone reads: the thread's items and its list row.
      const read = await call('thread/read', { threadId: id, window: { lastItems: 200 } });
      const row = (await call('thread/list', { limit: 1000 })).data.find((r) => r.id === id) ?? null;
      cases.push({ name: c.name, start, ...(second ? { second } : {}), stop, core: { reply, ...(again ? { again } : {}), items: read.items, row } });
    }
    return {
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
      socket?.close();
      try {
        if (core) {
          core.kill();
          await ended.race(core.exited, 'the core to exit');
        }
      } finally {
        try {
          if (provider) await ended.race(provider.close(), 'the model endpoint to close');
        } finally {
          killStrayPostgres(paths.dataDir);
        }
      }
    } finally {
      ended.clear();
    }
  }
}
