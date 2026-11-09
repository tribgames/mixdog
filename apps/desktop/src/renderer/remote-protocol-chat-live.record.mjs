// Records what a RUNNING mixdogd answers for the roster scenario of remote-protocol-chat-roster.recorded.json: it starts the daemon in an
// isolated env (the real-turn harness's env, PostgreSQL seeding, fake provider), builds the roster's sessions through the protocol (start,
// name, favorite, read cursor, fork, answered turns), then archives, unarchives, re-archives and deletes, and after each action saves the core's
// `thread/list` and every app-feed edge it pushed for it.
//
// Usage: node remote-protocol-chat-live.record.mjs <mixdogd.exe> <real-turn-harness dir>
// The harness files this imports are pinned by sha256 in the recording's manifest. Nothing here waits for time: each step ends when the app
// feed has delivered edges that fold to the core's own list (an event wait), and a hang ends the run through the harness deadline.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, watch, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { uuidv7 } from '../../../../packages/protocol-client/src/client.ts';

const [bin, harness] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const lib = (name) => join(harness, 'lib', name);
const PINNED = ['env.mjs', 'scenarios.mjs', 'stage.mjs', 'fake-provider.mjs', 'proc.mjs', 'deadline.mjs', 'pg-version.json'];
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
process.env.HARNESS_ENV_ROOT = join(harness, 'run', 'env-ph2-chat-live');
const load = (name) => import(pathToFileURL(lib(name)).href);
const { daemonEnv, isolatedPaths } = await load('env.mjs');
const { seedPgRuntime, killStrayPostgres } = await load('stage.mjs');
const { startFakeProvider } = await load('fake-provider.mjs');
const { launch } = await load('proc.mjs');
const { createDeadline, latch } = await load('deadline.mjs');

const paths = isolatedPaths();
rmSync(paths.envRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
const projects = { a: join(paths.workspace, 'a'), b: join(paths.workspace, 'b') };
for (const p of Object.values(projects)) mkdirSync(p, { recursive: true });
seedPgRuntime(paths.dataDir);
// thread/start needs a routable model, and a turn needs a provider that answers: the harness's fake OpenAI-compatible provider.
const provider = await startFakeProvider({ workspace: paths.workspace });
writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
const route = { provider: 'custom-harness', model: 'harness-model' };

const core = launch(bin, ['serve'], { env: daemonEnv(paths, { RUST_LOG: 'warn' }), cwd: paths.envRoot });
const deadline = createDeadline(240_000, () => core.tail());

// The core publishes daemon.json when it serves: a directory watch is the readiness event.
const daemonDoc = () => {
  const file = join(paths.runtimeRoot, 'daemon.json');
  if (!existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (d?.core?.state === 'blocked') throw new Error(`blocked ${JSON.stringify(d.core.blocked)}`);
    return d?.core?.state === 'serving' && d.core.rpc?.port ? d : null;
  } catch (e) {
    if (String(e.message).startsWith('blocked')) throw e;
    return null;
  }
};
const served = latch();
const watcher = watch(paths.runtimeRoot, () => {
  try { const d = daemonDoc(); if (d) served.resolve(d); } catch (e) { served.reject(e); }
});
const early = daemonDoc();
if (early) served.resolve(early);
const doc = await deadline.race(served.promise, 'the core to serve');
watcher.close();

const socket = new WebSocket(`ws://127.0.0.1:${doc.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${doc.endpoints.session.token}` }, perMessageDeflate: false });
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
const pending = new Map();
const edges = [];
const waiters = new Set();
let nextId = 1;
const EDGES = new Set(['thread/started', 'thread/summary/updated', 'thread/deleted', 'thread/archived', 'thread/unarchived']);
socket.on('message', (data) => {
  const frame = JSON.parse(data.toString('utf8'));
  if (frame.id !== undefined && pending.has(frame.id)) { const p = pending.get(frame.id); pending.delete(frame.id); frame.error ? p.reject(new Error(`: ${JSON.stringify(frame.error)}`)) : p.resolve(frame.result); }
  else if (frame.method) {
    if (EDGES.has(frame.method)) edges.push({ method: frame.method, params: frame.params });
    for (const check of [...waiters]) check();
  }
});
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject, method });
  socket.send(JSON.stringify({ id, method, params }));
});
// The core requires a lowercase UUIDv7 `opId`: the client library's own generator.
const op = (method, params) => call(method, { ...params, opId: uuidv7(Date.now()) });
/** Resolves when `ready()` holds, checked again at every notification the socket delivers. */
const until = (ready, what) => {
  const done = latch();
  const check = () => { if (ready()) { waiters.delete(check); done.resolve(); } };
  waiters.add(check);
  check();
  return deadline.race(done.promise, what);
};

// What the app feed has said, folded the way a listener folds it (an edge's thread is the list row plus provider and model).
const folded = () => {
  const rows = new Map();
  for (const { method, params } of edges) {
    if (method === 'thread/deleted') rows.delete(params.threadId);
    else if (method === 'thread/archived' || method === 'thread/unarchived') { const row = rows.get(params.threadId); if (row) rows.set(params.threadId, { ...row, archived: method === 'thread/archived' }); }
    else { const { provider, model, ...row } = params.thread; rows.set(row.id, row); }
  }
  return rows;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const steps = [];
/** Ends a step: the core's list, then the wait until the feed's edges fold to exactly it (and `settled` holds of the folded rows). */
async function step(name, action, settled = () => true) {
  const from = edges.length;
  await action();
  // The settled state is awaited before the list is read, so the list is the settled one.
  await until(() => settled(folded()), `the rows of ${name} to settle`);
  let listed;
  let want = new Map();
  const unequal = () => {
    const have = folded();
    return [...want].filter(([id, row]) => !same(have.get(id), row)).map(([id, row]) => ({ id, list: row, feed: have.get(id) ?? null }))
      .concat([...have].filter(([id]) => !want.has(id)).map(([id, row]) => ({ id, list: null, feed: row })));
  };
  // A hang's last-seen text names what still differs between the feed's fold and the list.
  const lastSeen = core.tail;
  core.tail = () => `${lastSeen()}\nfeed fold vs list: ${JSON.stringify(unequal())}`;
  // A write can land after the rows looked settled: the list is read again after each further edge until it and the feed's fold agree.
  for (;;) {
    const seen = edges.length;
    listed = await call('thread/list', { limit: 1000 });
    want = new Map(listed.data.map((row) => [row.id, row]));
    if (unequal().length === 0) break;
    await until(() => edges.length !== seen, `the app feed to fold to the core's list after ${name}`);
  }
  core.tail = lastSeen;
  steps.push({ name, listed, edges: edges.slice(from) });
}

let out;
try {
  await call('initialize', { clientInfo: { name: 'ph2-chat-live', title: 'PH-2 live roster', version: '1.4.5', kind: 'tui' }, capabilities: {} });
  socket.send(JSON.stringify({ method: 'initialized' }));
  await call('app/subscribe', {});
  // The roster's threads, made the way Node's host makes them (remote-protocol-chat-roster.record.mjs): a thread with a route in its draft
  // and a first answered prompt (Node stores no thread without one), then named; sess_2 is a fork of sess_0.
  const made = {};
  const turned = new Map();
  socket.on('message', (data) => { const f = JSON.parse(data.toString('utf8')); if (f.method === 'turn/completed') { turned.set(f.params.threadId, (turned.get(f.params.threadId) || 0) + 1); for (const check of [...waiters]) check(); } });
  /** One answered prompt on `id`: its `count`-th turn. */
  const turn = async (id, count, prompt) => {
    await call('thread/resume', { threadId: id, window: { lastItems: 200 } });
    await op('turn/start', { threadId: id, input: { prompt, options: { clientSubmissionId: `ph2-chat-live-${prompt.replaceAll(' ', '-')}` } } });
    await until(() => turned.get(id) >= count, `the turn ${count} of ${id} to complete`);
  };
  const newTask = async (name, project) => {
    made[name] = (await op('thread/start', { kind: 'project', projectPath: projects[project], draft: { route } })).thread.id;
    await turn(made[name], 1, `hello ${name}`);
  };
  // A turn's last write (lastUsedAt = updatedAt = its completion) lands after `turn/completed`: a step is over when each turned row says so.
  const answered = (names, count) => (rows) => names.every((name) => { const row = rows.get(made[name]); return row && row.messageCount === count * 2 && row.activityAt === row.updatedAt; });
  await step('created', async () => {
    for (const [name, project] of [['sess_0', 'b'], ['sess_1', 'a'], ['sess_3', 'a'], ['sess_4', 'b']]) {
      await newTask(name, project);
      await op('thread/name/set', { threadId: made[name], title: `Title ${name.slice(-1)}` });
    }
    // Node's inheritSession: a new session in the source's project, then inheritFrom into it.
    made.sess_2 = (await op('thread/start', { kind: 'project', projectPath: projects.b })).thread.id;
    await op('thread/fork', { threadId: made.sess_0, intoThreadId: made.sess_2 });
    await op('thread/name/set', { threadId: made.sess_2, title: 'Title 2' });
    await op('thread/metadata/update', { threadId: made.sess_2, favorite: true });
    await op('thread/readState/update', { threadId: made.sess_1, messageCount: 0, consumedUnread: true });
  }, (rows) => answered(['sess_0', 'sess_1', 'sess_3', 'sess_4'], 1)(rows) && rows.get(made.sess_1).readRevision === 1);
  await step('turns', async () => {
    for (const name of ['sess_1', 'sess_0']) await turn(made[name], 2, `again ${name}`);
  }, answered(['sess_1', 'sess_0'], 2));
  await step('archive', () => op('thread/archive', { threadId: made.sess_3 }));
  await step('unarchive', () => op('thread/unarchive', { threadId: made.sess_3 }));
  await step('archive-again', () => op('thread/archive', { threadId: made.sess_3 }));
  await step('delete', async () => {
    await newTask('sess_5', 'a');
    await op('thread/name/set', { threadId: made.sess_5, title: 'Title 5' });
    await op('thread/delete', { threadId: made.sess_5 });
  });
  const saveBot = async (name) => {
    const saved = await op('agent/saveAgentDefinition', { payload: { kind: 'bot', name, description: `${name} bot`, body: `You are ${name}.`, route } });
    return (saved.value ?? saved).id;
  };
  await step('agent-home', async () => {
    made.botOne = await saveBot('Bot One');
    made.botTwo = await saveBot('Bot Two');
    const opened = await op('agent/home/open', { agentId: made.botOne });
    made.botOneHome = opened.sessionId ?? opened.threadId ?? opened.thread?.id;
    if (made.botOneHome !== `sess_home_${made.botOne}`) throw new Error(`agent/home/open answered ${JSON.stringify(opened)}`);
    await turn(made.botOneHome, 1, 'hello Bot One');
  }, (rows) => rows.get(made.botOneHome)?.messageCount === 2);
  await step('room', async () => {
    const created = await op('room/create', { input: { name: 'Room One', members: [made.botOne, made.botTwo] } });
    made.room = created.roomId;
    made.roomLog = created.sessionId;
  });
  await step('agent-delete', () => op('agent/deleteAgentDefinition', { agentId: made.botOne }));
  out = {
    manifest: {
      binary: bin, binarySha256: sha256(bin), binaryBuilt: statSync(bin).mtime.toISOString(),
      server: (await call('server/info', {}).catch(() => null)) ?? null,
      // The task workspace as the core itself names it (project/taskWorkspace): where a session made outside a project lives.
      taskWorkspace: (await call('project/taskWorkspace', {})).path,
      harness: Object.fromEntries(PINNED.map((name) => [`lib/${name}`, sha256(lib(name))])),
      source: 'running mixdogd serve, isolated env (real-turn harness env.mjs / stage.mjs / fake-provider.mjs, pinned above), driven over the WebSocket JSON-RPC protocol',
    },
    made, projects, steps,
  };
  writeFileSync(join(here, 'remote-protocol-chat-live.recorded.json'), JSON.stringify(out, null, 2));
  console.log(`recorded ${steps.length} steps, ${edges.length} app-feed edges, ${steps.at(-1).listed.data.length} rows listed at the end`);
} finally {
  deadline.clear();
  socket.close();
  core.kill();
  await core.exited;
  killStrayPostgres(paths.dataDir);
}
process.exit(0);
