// The replay of the new-task quit cases (cases.mjs) against a built `mixdogd` (built with `--features crash-gates`), in the folder Node's
// recording used (the project path is part of the request and of its receipt's signature). The client is the desktop's own service lane
// (apps/desktop/src/main/protocol/service-route.ts: `submitNewTask` becomes `thread/start`) over a protocol connection.
//
// A held case: the core starts with its hold at the case's step (MIXDOG_NEW_TASK_QUIT_AT), the request is sent, the core says the
// attempt is held there, the app's listing is read, the app's quit detaches the caller (its connection closes) and stops the core as the
// app's quit stops Node's daemon (`mixdogd ctl stop --when-idle --reason userStop`: a stop request that does not wait for the new task,
// as Node's `/stop {force:true}`); the hold goes on once the stop request cut the attempt. The core starts again and the request comes
// in again. Each step is compared whole with Node's (COMPARISON).
import { execFileSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REPO_ROOT } from '../lib/common.mjs';
import { answered, killTree, startCore } from '../lib/phone-files-replay.mjs';
import { holdPorts, receiptsOf, stopCore, translatedAnswer } from '../new-task-dedupe/replay.mjs';
import { COMPARISON, caseRoot, numberFresh } from './cases.mjs';

process.on('unhandledRejection', (error) => {
  if (error?.message !== 'the replay dropped its connection') throw error;
});

const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const REAL_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const asReceived = {
  answer: (result) => ({ ok: true, ...result }),
  rejection: (error) => ({ ok: false, error: String(error?.message ?? error), ...(error && typeof error === 'object' ? { ...error } : {}) }),
};

/** The model endpoint as the recording's (world.mjs): a turn's answer is one short text; `streams` resolves as turn streams finish. */
async function startProvider() {
  let streamed = 0;
  const waiters = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method === 'HEAD') return void res.end();
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        return void res.end(JSON.stringify({ object: 'list', data: [{ id: 'harness-model', object: 'model' }] }));
      }
      const body = JSON.parse(raw || '{}');
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      if (body.stream !== true) {
        res.setHeader('content-type', 'application/json');
        return void res.end(JSON.stringify({ id: 'chatcmpl-quit', object: 'chat.completion', model: 'harness-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage }));
      }
      res.once('finish', () => {
        streamed += 1;
        for (const wake of waiters) wake();
      });
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-quit', object: 'chat.completion.chunk', created: 1700000000, model: 'harness-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ role: 'assistant', content: '' }));
      res.write(chunk({ content: 'ok' }));
      res.write(chunk({}, 'stop'));
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-quit', object: 'chat.completion.chunk', model: 'harness-model', choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    streamed: () => streamed,
    waiters,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

/** The case's world: the project (a git repository with one commit, as the recording's) and the core's folders with its provider config. */
function prepareWorld(c, provider) {
  const root = caseRoot(c);
  rmSync(root, { recursive: true, force: true });
  const project = join(root, 'ws', 'proj');
  mkdirSync(project, { recursive: true });
  const git = (...args) => execFileSync(REAL_GIT, args, { cwd: project, env: { ...process.env, GIT_CEILING_DIRECTORIES: join(root, 'ws'), GIT_AUTHOR_NAME: 'rec', GIT_AUTHOR_EMAIL: 'rec@example.invalid', GIT_COMMITTER_NAME: 'rec', GIT_COMMITTER_EMAIL: 'rec@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'project\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'first');
  const coreRoot = join(root, 'core');
  for (const dir of ['runtime', 'data', 'home', 'config']) mkdirSync(join(coreRoot, dir), { recursive: true });
  writeFileSync(join(coreRoot, 'data', 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
  return { root, project, coreRoot, env: { GIT_CEILING_DIRECTORIES: join(root, 'ws') } };
}

/** The app's connection: the service lane over a protocol client whose thread folds are kept (the workflow section is read from them). */
async function connectApp(core) {
  const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
  const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
  const { createServiceLane } = await here('apps/desktop/src/main/protocol/service-route.ts');
  const folds = new Map();
  const notes = [];
  const listeners = new Set();
  const keep = (state) => {
    if (state?.sessionId) folds.set(state.sessionId, state);
    return state;
  };
  const client = await answered('the connection (initialize)', connect({
    target: { id: 'core' },
    connector: createWsConnector(async () => core.endpoint),
    clientInfo: { name: 'mixdog-replay', title: 'Mixdog Replay', version: '1.4.5', kind: 'desktop' },
    capabilities: { optOutNotificationMethods: [], experimentalApi: false },
    threadReducer: {
      initial: (snapshot) => {
        // The subscription's snapshot: one taken once the turn has ended is idle with the turn's answer in it.
        const done = snapshot?.thread?.status?.type === 'idle' && (snapshot?.items ?? []).some((item) => item?.type === 'agentMessage' || item?.role === 'assistant');
        notes.push({ method: '(snapshot)', params: { threadId: snapshot?.thread?.id, done } });
        for (const wake of listeners) wake();
        return keep(sessionReducer.initial(snapshot));
      },
      apply: (state, notification) => {
        notes.push(notification);
        for (const wake of listeners) wake();
        return keep(sessionReducer.apply(state, notification));
      },
    },
    clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
    random: Math.random,
  }));
  const lane = createServiceLane({ protocol: { call: (method, params) => client.call(method, params), notify() {} }, snapshot: () => null });
  return { client, lane, folds, notes, listeners };
}

/** Resolves once `ready()` holds, re-checked on every `wakers` wake; fails naming `what` after `ms`. */
function until(wakers, ready, what, ms = 120_000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!ready()) return;
      done();
      resolve();
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`${what}: not within ${ms} ms`));
    }, ms);
    const done = () => {
      clearTimeout(timer);
      for (const set of wakers) set.delete(check);
    };
    for (const set of wakers) set.add(check);
    check();
  });
}

const submit = async (app, c, project) => {
  try {
    return asReceived.answer(await answered('submitNewTask (thread/start)', app.lane.call('submitNewTask', [c.content.prompt, { ...c.content.options, id: c.id }, { ...structuredClone(c.content.draft), projectPath: project }])));
  } catch (error) {
    return asReceived.rejection(error);
  }
};

/** The accepted task's first turn has ended: the model endpoint finished its stream and the core said the turn completed (on the
 *  thread's subscription, taken here as the app's window takes it, or in its snapshot when the turn had ended before). */
async function turnSettled(app, provider, threadId) {
  const ended = until(
    [app.listeners, provider.waiters],
    () => provider.streamed() > 0 && app.notes.some((n) => n.params?.threadId === threadId && (n.method === 'turn/completed' || (n.method === '(snapshot)' && n.params.done))),
    `the first turn of ${threadId} to end`,
  );
  await answered(`thread/resume of ${threadId}`, app.client.resumeThread(threadId, { lastItems: 50 }));
  await ended;
}

/** The sessions the core stored (`<data>/sessions`, one folder each), each that the core still reads (`thread/items/list`). */
async function storedOf(app, dataDir) {
  let ids = [];
  try {
    ids = readdirSync(join(dataDir, 'sessions')).sort();
  } catch {}
  const out = [];
  for (const id of ids) {
    try {
      await answered(`thread/items/list of ${id}`, app.client.call('thread/items/list', { threadId: id }));
      out.push(id);
    } catch (error) {
      if (error.code !== 'threadNotFound') throw error;
    }
  }
  return out;
}

const stopped = { stopped: true, request: 'sent' };

async function replayCase({ exe, c, provider }) {
  const world = prepareWorld(c, provider);
  const cores = [];
  const apps = [];
  const own = async (extra) => {
    const core = await startCore(exe, world.coreRoot, null, false, { ...world.env, ...extra });
    cores.push(core);
    return core;
  };
  const open = async (core) => {
    const app = await connectApp(core);
    apps.push(app);
    return app;
  };
  const got = [];
  let failed = null;
  try {
    let core = await own(c.hold ? { MIXDOG_NEW_TASK_QUIT_AT: c.hold.step } : {});
    let app = await open(core);
    await answered('addProject', app.lane.call('addProject', [world.project]));
    if (c.hold) {
      const marker = `new-task held at ${c.hold.step}`;
      let said = '';
      const hear = new Set();
      core.child.stderr.on('data', (chunk) => {
        said += chunk;
        for (const wake of hear) wake();
      });
      let reply = null;
      let detached = false;
      // An answer that comes once the caller is detached is the client's own rejection of its pending call, not the core's.
      const pending = submit(app, c, world.project).then((answer) => (reply = detached ? { ok: false, unanswered: true } : answer));
      await until([hear], () => said.includes(marker) || reply !== null, `the attempt to be held at ${c.hold.step}`);
      if (reply) throw new Error(`the attempt ended before it was held at ${c.hold.step}: ${JSON.stringify(reply)}`);
      const listed = (await answered('thread/list', app.client.call('thread/list', {}))).data.map((thread) => thread.id);
      // The app's quit: its connection closes (the caller is detached), then the core is asked to stop.
      detached = true;
      app.client.close?.();
      (await stopCore(exe, core))();
      await pending;
      core = await own({});
      app = await open(core);
      got.push({ listed, reply, stop: stopped, receipts: receiptsOf(core.dataDir), stored: await storedOf(app, core.dataDir) });
      const retry = await submit(app, c, world.project);
      const thread = retry.ok ? retry.thread?.id : null;
      if (thread) await turnSettled(app, provider, thread);
      const stored = await storedOf(app, core.dataDir);
      app.client.close?.();
      (await stopCore(exe, core))();
      got.push({ reply: translatedAnswer(retry), stop: stopped, receipts: receiptsOf(core.dataDir), stored });
    } else {
      const answer = await submit(app, c, world.project);
      const thread = answer.ok ? answer.thread?.id : null;
      if (thread) await turnSettled(app, provider, thread);
      const fold = thread ? app.folds.get(thread) : null;
      const settings = thread ? { workflow: fold?.fields?.workflow ?? null, orchestrationMode: fold?.fields?.orchestrationMode ?? null } : null;
      const stored = await storedOf(app, core.dataDir);
      app.client.close?.();
      (await stopCore(exe, core))();
      got.push({ reply: translatedAnswer(answer), settings, stop: stopped, receipts: receiptsOf(core.dataDir), stored });
    }
  } catch (error) {
    failed = error;
  }
  for (const app of apps) app.client.close?.();
  for (const core of cores) await killTree(core.child).catch((error) => (failed ??= error));
  if (failed) throw failed;
  rmSync(world.root, { recursive: true, force: true });
  return numberFresh(c, got);
}

const differences = (a, b, path = '') => {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => differences(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return [path];
};

/** Node's side as compared (COMPARISON.translated): the interrupted request's answer is the app's own client's rejection at its disposal. */
const nodeSide = (recorded, c) => recorded.map((step, index) => (c.hold && index === 0 && step.reply?.ok === false ? { ...step, reply: { ok: false, unanswered: true } } : step));

export async function replayNewTaskQuit({ exe, cases, golden }) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'native', 'core', 'fixtures', 'new-task-quit', 'MANIFEST.json'), 'utf8'));
  if (!isDeepStrictEqual(manifest.comparison, COMPARISON)) throw new Error('the manifest declares another comparison than cases.mjs COMPARISON: record the fixture again');
  const release = await holdPorts();
  const provider = await startProvider();
  let failed = 0;
  const started = Date.now();
  try {
    // The cases are independent (each its own core, data directory and ports): they run side by side, reported in order.
    const runs = cases.map((c) => {
      const caseStarted = Date.now();
      return replayCase({ exe, c, provider }).then(
        (got) => ({ got, seconds: Math.round((Date.now() - caseStarted) / 1000) }),
        (error) => ({ error }),
      );
    });
    for (const [index, c] of cases.entries()) {
      const run = await runs[index];
      const expected = nodeSide(golden[c.name].recorded, c);
      if (run.error) {
        failed += 1;
        console.log(`${c.name}: FAILED ${run.error.stack}`);
        continue;
      }
      const got = run.got;
      const unexpected = [];
      if (!isDeepStrictEqual(golden[c.name].case, JSON.parse(JSON.stringify(c)))) unexpected.push({ index: 'case', paths: ['case'], node: golden[c.name].case, core: c });
      expected.forEach((node, index) => {
        const paths = differences(node, got[index]);
        if (paths.length) unexpected.push({ index, paths, node, core: got[index] });
      });
      if (got.length !== expected.length) unexpected.push({ index: 'count', paths: ['length'], node: expected.length, core: got.length });
      console.log(`${c.name}: ${expected.length} steps compared, ${unexpected.length} unexpected (${run.seconds} s)`);
      for (const entry of unexpected) {
        failed += 1;
        console.log(`  DIFF step ${entry.index} at ${entry.paths.join(', ')}`);
        console.log(`    node: ${JSON.stringify(entry.node).slice(0, 3000)}`);
        console.log(`    core: ${JSON.stringify(entry.core).slice(0, 3000)}`);
      }
    }
  } finally {
    await provider.close();
    release();
  }
  console.log(`replayed ${cases.length} cases in ${Math.round((Date.now() - started) / 1000)} s`);
  return failed ? 1 : 0;
}
