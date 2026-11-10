#!/usr/bin/env node
// A built mixdogd driven for real through the roster scenario Node's own host recorded (`record-roster-steps.mjs` →
// `native/core/fixtures/roster-steps/steps.json`): threads made and named, a fork, a favorite, a read cursor, second turns, an
// archive, an unarchive, a re-archive, a delete, an agent's home spoken in, a room of two bots, and the deletion of one bot. After
// each action the core's `thread/list` must equal Node's roster of that step, row for row and in order, and the app feed's edges
// (`thread/started`, `thread/summary/updated`, `thread/deleted`, `thread/archived`, `thread/unarchived`), folded as a listener folds
// them, must equal that list. It FAILS (exit 1) on the first step that differs, naming the step and the rows.
//
// The two runs differ only in what they are, not in what they do, and these are named, never dropped: each session's id (made at
// random) by the scenario's name for it; the projects and the task workspace (each run's own folders) by their role; the times
// (each run's clock) per field by their order of first appearance in the scenario. Node's roster names the fork source
// `inheritedFromSessionId`, the protocol `forkedFromId`.
//
// Every wait is on an event (the discovery file appearing, a frame on the socket, the core's exit) under a deadline naming what did
// not happen. The world is a folder of its own (mkdtemp); the core is ended through its own stop (`mixdogd ctl stop --when-idle`),
// awaited on its exit; the PostgreSQL cluster of the world is stopped with its own `pg_ctl stop -D` (sandbox-janitor.mjs); a
// process still naming the world is not killed: the run fails naming it and the world stays.
//
//   node benchmarks/rust-core/recorders/replay-roster-rows-live.mjs --exe <mixdogd.exe> --harness <real-turn-harness dir> [--only <action>]
// --only runs the actions up to and including the named one (each builds on the ones before) and compares those steps.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, REPO_ROOT, parseArgs } from './lib/common.mjs';
import { endSandbox } from './sandbox-janitor.mjs';

const args = parseArgs();
const exe = args.get('exe');
const harness = args.get('harness');
const only = args.get('only');
const node = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'roster-steps', 'steps.json'), 'utf8'));
const ACTIONS = node.steps.map((step) => step.name);
if (!exe || !existsSync(exe) || !harness) {
  console.error('usage: replay-roster-rows-live.mjs --exe <mixdogd.exe> --harness <real-turn-harness dir> [--only <action>]');
  process.exit(2);
}
if (only && !ACTIONS.includes(only)) {
  console.error(`--only ${only}: unknown action; known: ${ACTIONS.join(', ')}`);
  process.exit(2);
}
const WebSocket = createRequire(join(REPO_ROOT, 'package.json'))('ws');
const hload = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
const { daemonEnv, isolatedPaths } = await hload('env.mjs');
const { seedPgRuntime } = await hload('stage.mjs');
const { startFakeProvider } = await hload('fake-provider.mjs');
const { parseDiscovery } = await import(pathToFileURL(join(REPO_ROOT, 'apps/desktop/src/main/protocol/discovery.ts')).href);

const world = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:\\mixdog-build\\tmp', 'roster-live-'));
const paths = isolatedPaths(world);
const failures = [];
let child = null;
let socket = null;
let provider = null;
let coreEnv = null;
let stderr = '';
let seen = '';

// Resolves with the first truthy `probe()`, tried now and at every event `subscribe` reports; rejects naming `label` at the deadline.
const waitOn = (label, ms, subscribe, probe) =>
  new Promise((resolve, reject) => {
    let done = false;
    let stop = () => {};
    const timer = setTimeout(() => finish(reject, new Error(`${label}: not done after ${ms} ms${seen ? ` (last seen: ${seen})` : ''}`)), ms);
    const finish = (settle, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      settle(value);
    };
    const attempt = async () => {
      try {
        const value = await probe();
        if (value) finish(resolve, value);
      } catch (error) {
        finish(reject, error);
      }
    };
    stop = subscribe(attempt);
    void attempt();
  });

// Ends everything this run started, by ownership: the socket, the core through its own stop, the model endpoint, the cluster and the
// world (sandbox-janitor.mjs). Returns the failures.
async function endWorld() {
  const ended = [];
  try {
    socket?.close();
  } catch (error) {
    ended.push(`closing the socket: ${error.message}`);
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    const stop = spawnSync(exe, ['ctl', 'stop', '--when-idle', '--reason', 'quit'], { env: coreEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (stop.error || stop.status !== 0) ended.push(`mixdogd ctl stop answered ${stop.error?.message ?? stop.status}: ${stop.stderr}`);
    try {
      await waitOn('mixdogd exiting after its stop', 60_000, (attempt) => (child.once('exit', attempt), () => child.off('exit', attempt)), async () => child.exitCode !== null || child.signalCode !== null);
    } catch (error) {
      ended.push(error.message);
    }
  }
  if (provider) await provider.close();
  ended.push(...endSandbox(world, 0, paths.dataDir));
  return ended;
}

// ── the comparison ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TIMES = ['createdAt', 'updatedAt', 'activityAt'];
/** The canonical form of one side's rows: ids, folders and times named as the header says. */
function canon(side) {
  const ranks = Object.fromEntries(TIMES.map((key) => [key, []]));
  const folders = [['<project a>', side.projects.a], ['<project b>', side.projects.b], ['<task workspace>', side.taskWorkspace]].sort(([, a], [, b]) => b.length - a.length);
  return (rows) => {
    // The ids made so far (a step names the sessions the steps before it made).
    const ids = Object.entries(side.made).filter(([, id]) => typeof id === 'string' && id).sort(([, a], [, b]) => b.length - a.length);
    let text = JSON.stringify(rows);
    for (const [name, id] of ids) text = text.split(id).join(`<${name}>`);
    for (const [name, folder] of folders) text = text.split(JSON.stringify(folder).slice(1, -1)).join(name);
    return JSON.parse(text).map((row) => {
      const out = { ...row };
      if ('inheritedFromSessionId' in out) {
        out.forkedFromId = out.inheritedFromSessionId;
        delete out.inheritedFromSessionId;
      }
      for (const key of TIMES) {
        if (typeof out[key] !== 'number') continue;
        let at = ranks[key].indexOf(out[key]);
        if (at < 0) at = ranks[key].push(out[key]) - 1;
        out[key] = `<${key} ${at}>`;
      }
      return out;
    });
  };
}

/** The one known difference, named and checked rather than passed over (reported for decisions.md, owner: Lead; the same rule as
 *  `room_publication::tests::live_form`): Node's daemon lists a session it still holds live from the session object, a row with
 *  neither `compactCount` nor `incomingTail` (`store-summary-real-turns.test.mjs:115-118`; a stored row always carries
 *  `compactCount`, `store-summary-index.mjs:350`); the core's row is always the stored summary's. Where Node's row is that live form
 *  (no `compactCount`), exactly those two fields are taken off the core's row; any other difference stays. */
function liveForm(core, node) {
  if (!node || 'compactCount' in node || 'incomingTail' in node) return core;
  const { compactCount: _count, incomingTail: _tail, ...rest } = core;
  return rest;
}

try {
  // ---- the world: the harness's PostgreSQL runtime and model endpoint, two projects, the config naming the endpoint ----
  for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
  const projects = { a: join(paths.workspace, 'a'), b: join(paths.workspace, 'b') };
  for (const p of Object.values(projects)) mkdirSync(p, { recursive: true });
  seedPgRuntime(paths.dataDir);
  provider = await startFakeProvider({ workspace: paths.workspace });
  writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
  const route = { provider: 'custom-harness', model: 'harness-model' };

  // ---- the core ----
  coreEnv = daemonEnv(paths, { RUST_LOG: 'warn' });
  if (!existsSync(join(exe, '..', 'js-runtime.json'))) throw new Error(`${join(exe, '..', 'js-runtime.json')} is missing: the core cannot start its JS runtime`);
  child = spawn(exe, ['serve'], { env: coreEnv, cwd: world, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-20_000);
  });
  const file = join(paths.runtimeRoot, 'daemon.json');
  const endpoint = await waitOn(
    'mixdogd publishing its discovery file',
    120_000,
    (attempt) => {
      const watcher = watch(paths.runtimeRoot, attempt);
      child.once('exit', attempt);
      return () => (watcher.close(), child.off('exit', attempt));
    },
    async () => {
      if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}`);
      try {
        return parseDiscovery(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    }
  );
  socket = new WebSocket(endpoint.url, { headers: { Authorization: `Bearer ${endpoint.token}` }, perMessageDeflate: false });
  await waitOn('the app-server socket to open', 30_000, (attempt) => (socket.once('open', attempt), socket.once('error', attempt), () => {}), async () => {
    if (socket.readyState === WebSocket.CLOSED) throw new Error('the app-server socket closed while opening');
    return socket.readyState === WebSocket.OPEN;
  });
  const pending = new Map();
  const edges = [];
  const listeners = new Set();
  const turned = new Map();
  let nextId = 1;
  const EDGES = new Set(['thread/started', 'thread/summary/updated', 'thread/deleted', 'thread/archived', 'thread/unarchived']);
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8'));
    if (frame.id !== undefined && pending.has(frame.id)) {
      const p = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) p.reject(new Error(`${p.method}: ${JSON.stringify(frame.error)}`));
      else p.resolve(frame.result);
    } else if (frame.method) {
      if (EDGES.has(frame.method)) edges.push({ method: frame.method, params: frame.params });
      if (frame.method === 'turn/completed') turned.set(frame.params.threadId, (turned.get(frame.params.threadId) || 0) + 1);
    }
    for (const listener of [...listeners]) listener();
  });
  const onFrame = (attempt) => (listeners.add(attempt), () => listeners.delete(attempt));
  const call = (method, params) => {
    const id = nextId++;
    const answered = new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
    socket.send(JSON.stringify({ id, method, params }));
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method}: no answer after 60000 ms`)), 60_000);
    });
    return Promise.race([answered, expired]).finally(() => clearTimeout(timer));
  };
  // The client library's UUIDv7 generator gives the `opId` the core requires.
  const { uuidv7 } = await import(pathToFileURL(join(REPO_ROOT, 'packages/protocol-client/src/client.ts')).href);
  const op = (method, params) => call(method, { ...params, opId: uuidv7(Date.now()) });
  const until = (label, ready) => waitOn(label, 120_000, onFrame, async () => ready());

  // What the app feed has said, folded as a listener folds it (an edge's thread is a list row).
  const folded = () => {
    const rows = new Map();
    for (const { method, params } of edges) {
      if (method === 'thread/deleted') rows.delete(params.threadId);
      else if (method === 'thread/archived' || method === 'thread/unarchived') {
        const row = rows.get(params.threadId);
        if (row) rows.set(params.threadId, method === 'thread/archived' ? { ...row, archived: true } : (({ archived: _a, ...rest }) => rest)(row));
      } else rows.set(params.thread.id, params.thread);
    }
    return rows;
  };

  await call('initialize', { clientInfo: { name: 'roster-live', title: 'roster live replay', version: '1.4.5', kind: 'tui' }, capabilities: {} });
  socket.send(JSON.stringify({ method: 'initialized' }));
  await call('app/subscribe', {});

  const made = {};
  const turn = async (id, count, prompt) => {
    await call('thread/resume', { threadId: id, window: { lastItems: 200 } });
    await op('turn/start', { threadId: id, input: { prompt, options: { clientSubmissionId: `roster-live-${prompt.replaceAll(' ', '-')}` } } });
    await until(`the turn ${count} of ${id} to complete`, () => turned.get(id) >= count);
  };
  const newTask = async (name, project) => {
    made[name] = (await op('thread/start', { kind: 'project', projectPath: projects[project], draft: { route } })).thread.id;
    await turn(made[name], 1, `hello ${name}`);
  };
  const saveBot = async (name) => {
    const saved = await op('agent/saveAgentDefinition', { payload: { kind: 'bot', name, description: `${name} bot`, body: `You are ${name}.`, route } });
    return (saved.value ?? saved).id;
  };
  // A turn's last write (lastUsedAt = updatedAt = its completion) lands after `turn/completed`: a step is over when each turned row says so.
  const answered = (names, count) => (rows) => names.every((name) => { const row = rows.get(made[name]); return row && row.messageCount === count * 2 && row.activityAt === row.updatedAt; });
  const STEPS = {
    created: [
      async () => {
        for (const [name, project] of [['sess_0', 'b'], ['sess_1', 'a'], ['sess_3', 'a'], ['sess_4', 'b']]) {
          await newTask(name, project);
          await op('thread/name/set', { threadId: made[name], title: `Title ${name.slice(-1)}` });
        }
        made.sess_2 = (await op('thread/start', { kind: 'project', projectPath: projects.b })).thread.id;
        await op('thread/fork', { threadId: made.sess_0, intoThreadId: made.sess_2 });
        await op('thread/name/set', { threadId: made.sess_2, title: 'Title 2' });
        await op('thread/metadata/update', { threadId: made.sess_2, favorite: true });
        await op('thread/readState/update', { threadId: made.sess_1, messageCount: 0, consumedUnread: true });
      },
      (rows) => answered(['sess_0', 'sess_1', 'sess_3', 'sess_4'], 1)(rows) && rows.get(made.sess_1)?.readRevision === 1,
    ],
    turns: [
      async () => {
        await turn(made.sess_1, 2, 'again sess_1');
        await turn(made.sess_0, 2, 'again sess_0');
      },
      (rows) => answered(['sess_1', 'sess_0'], 2)(rows),
    ],
    archive: [() => op('thread/archive', { threadId: made.sess_3 }), () => true],
    unarchive: [() => op('thread/unarchive', { threadId: made.sess_3 }), () => true],
    'archive-again': [() => op('thread/archive', { threadId: made.sess_3 }), () => true],
    delete: [
      async () => {
        await newTask('sess_5', 'a');
        await op('thread/name/set', { threadId: made.sess_5, title: 'Title 5' });
        await op('thread/delete', { threadId: made.sess_5 });
      },
      () => true,
    ],
    'agent-home': [
      async () => {
        made.botOne = await saveBot('Bot One');
        made.botTwo = await saveBot('Bot Two');
        const opened = await op('agent/home/open', { agentId: made.botOne });
        made.botOneHome = opened.sessionId ?? opened.threadId ?? opened.thread?.id;
        await turn(made.botOneHome, 1, 'hello Bot One');
      },
      (rows) => rows.get(made.botOneHome)?.messageCount === 2,
    ],
    room: [
      async () => {
        const created = await op('room/create', { input: { name: 'Room One', members: [made.botOne, made.botTwo] } });
        made.room = created.roomId;
        made.roomLog = created.sessionId;
      },
      (rows) => rows.has(made.roomLog),
    ],
    // The core retires the home after the delete's reply, as Node's host does (`void retireAgentHomes`,
    // session-host-lifecycle.ts:1171): the step ends when the home row says it was retired and the room has dropped the bot.
    'agent-delete': [
      () => op('agent/deleteAgentDefinition', { agentId: made.botOne }),
      (rows) => rows.get(made.botOneHome)?.agentDeleted === true && !rows.get(made.roomLog)?.agentRoom?.members.includes(made.botOne),
    ],
  };
  const taskWorkspace = (await call('project/taskWorkspace', {})).path;
  const nodeCanon = canon(node);
  const coreCanon = canon({ made, projects, taskWorkspace });
  for (const step of node.steps) {
    const [act, settled] = STEPS[step.name];
    await act();
    seen = `step ${step.name}`;
    await until(`the rows of ${step.name} to settle`, () => settled(folded()));
    // The list, read again after each further edge until it and the feed's fold agree (a write can land after the rows settled).
    let listed;
    for (;;) {
      const at = edges.length;
      listed = (await call('thread/list', { limit: 1000 })).data;
      const fold = folded();
      if (listed.length === fold.size && listed.every((row) => isDeepStrictEqual(fold.get(row.id), row))) break;
      seen = `step ${step.name}: the feed's fold and the list differ: ${JSON.stringify({ list: listed.map((r) => r.id), fold: [...fold.keys()] })}`;
      await until(`the app feed to fold to the core's list after ${step.name}`, () => edges.length !== at);
    }
    const want = nodeCanon(step.roster);
    const got = coreCanon(listed).map((row, i) => liveForm(row, want[i]));
    if (!isDeepStrictEqual(got, want)) {
      const rows = Math.max(got.length, want.length);
      const differences = [];
      for (let i = 0; i < rows; i += 1) {
        const [c, n] = [got[i] ?? {}, want[i] ?? {}];
        const keys = [...new Set([...Object.keys(c), ...Object.keys(n)])].filter((key) => !isDeepStrictEqual(c[key], n[key]));
        if (keys.length) differences.push({ row: i, core: Object.fromEntries(keys.map((k) => [k, c[k] ?? '(absent)'])), node: Object.fromEntries(keys.map((k) => [k, n[k] ?? '(absent)'])) });
      }
      failures.push(`step ${step.name}: the core's list is not Node's roster (${got.length} rows, Node ${want.length}):\n${JSON.stringify(differences, null, 1)}`);
      break;
    }
    console.log(`step ${step.name}: ${listed.length} rows equal Node's; ${edges.length} edges so far fold to them`);
    if (step.name === only) break;
  }
} catch (error) {
  failures.push(`${error.message}${stderr ? `\nmixdogd stderr (tail):\n${stderr.slice(-3000)}` : ''}`);
} finally {
  failures.push(...(await endWorld()));
}
for (const failure of failures) console.error(`FAIL roster-live: ${failure}`);
process.exit(failures.length ? 1 : 0);
