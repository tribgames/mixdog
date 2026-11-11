#!/usr/bin/env node
// Records, from Node with the sensitive-value patches (node-patches/node-fix-sensitive-gaps.patch last), the three paths
// by which a session's text leaves it besides a worker's report, each with values marked sensitive in that session:
//   read  - the agent tool's `read` of a worker (agent-tool/execute.mjs readJob over a scripted world, as
//           record-agent-tool.mjs drives it): the rendered answer;
//   room  - a member's speech posted into a room (the desktop's createRoomLog over the daemon's createAgentRoomDelivery):
//           after each post, the log's message contents, the rows the room shows and the list preview;
//   home  - a task's report and a routine run's result reaching an agent's home (createAgentHomeDelivery over a real
//           routine-results.json, as record-home-delivery.mjs drives it, with a `mark` op): after each operation, the
//           queue file, the home threads, the live notices, the wake turns and the retry delays.
// A mark is `rememberSensitiveValues(session, [a browser fill with sensitive:true and the values as its fields])`.
// Every value is a test value.
//
//   node benchmarks/rust-core/recorders/record-sensitive-gaps.mjs --tree <tree> --patch <patch>,...
//
// Output: native/core/fixtures/sensitive-gaps/golden.json (+ MANIFEST.json).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import nodeCrypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, patchedProductIdentity, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-sensitive-gaps.mjs';
const args = parseArgs();
for (const name of args.keys()) if (!['tree', 'patch'].includes(name)) throw new Error(`unknown option --${name} (known: --tree, --patch)`);
const tree = resolveTree(args);
if (!args.get('patch')) throw new Error('pass --patch with the sensitive-value patches, in order');
const identity = patchedProductIdentity(tree, NODE_COMMIT, args.get('patch'));
const dir = mkdtempSync(join(tmpdir(), 'sensitive-gaps-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
process.env.MIXDOG_DATA_DIR = join(dir, 'data');

// The home delivery draws its wake ids from crypto.randomUUID and its times from Date.now: both made repeatable.
let uuidCounter = 0;
nodeCrypto.randomUUID = () => `00000000-0000-4000-8000-${(++uuidCounter).toString(16).padStart(12, '0')}`;
syncBuiltinESMExports();
const T0 = 1_800_000_000_000;
let clock = T0;
Date.now = () => clock;

const { rememberSensitiveValues } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/sensitive-values.mjs');
const { createAgentExecute } = await importFrom(tree, 'src/session-runtime/services/agent-tool/execute.mjs');
const { createAgentRoomDelivery } = await importFrom(tree, 'src/session-runtime/agent-room-delivery.mjs');
const { createRoomLog } = await importFrom(tree, 'apps/desktop/src/main/agent-room-log.ts');
const { createAgentHomeDelivery, createRoutineResultQueue } = await importFrom(tree, 'src/session-runtime/agent-home-delivery.mjs');

const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The execution call that marks `values` (a browser fill with sensitive:true, one field per value). */
const fillOf = (values) => ({ name: 'browser', arguments: { action: 'fill', input: { sensitive: true, fields: values.map((text) => ({ text })) } } });
const mark = ({ session, values }) => {
  if (!rememberSensitiveValues(session, [fillOf(values)])) throw new Error(`marking ${session} gained nothing`);
};

// --- read --------------------------------------------------------------------------------------
// `job` is what the views hand back (`taskId` null: a worker read off its session, `sessionId` its session), `view` its
// rendered envelope, `result` the worker's own text when no handoff is read.
const CODE = '482913';
const QUOTED = 'pa"ss';
const worker = (sessionId, result) => ({ taskId: null, sessionId, view: { task_id: `w_${sessionId}`, status: 'idle', type: 'spawn', tag: 'alpha', sessionId }, ...(result === undefined ? {} : { result }) });
const READS = [
  { name: 'handoff_of_a_marked_worker', marks: [{ session: 'sess_rd_1', values: [CODE] }], job: worker('sess_rd_1'), handoff: `the code is ${CODE}, again ${CODE}` },
  { name: 'own_text_of_a_marked_worker_without_handoff', marks: [{ session: 'sess_rd_2', values: [CODE] }], job: worker('sess_rd_2', `fallback ${CODE}`), handoff: null },
  { name: 'a_value_as_typed_and_as_json_spells_it', marks: [{ session: 'sess_rd_3', values: [QUOTED] }], job: worker('sess_rd_3'), handoff: `typed ${QUOTED} and in json "pa\\"ss"` },
  { name: 'the_longer_value_first', marks: [{ session: 'sess_rd_4', values: ['4829', CODE] }], job: worker('sess_rd_4'), handoff: `long ${CODE} short 4829` },
  { name: 'a_marker_is_never_rewritten', marks: [{ session: 'sess_rd_5', values: ['e'] }], job: worker('sess_rd_5'), handoff: 'see [redacted] and [saved login]' },
  { name: 'an_unmarked_worker_reads_as_it_is', marks: [{ session: 'sess_rd_other', values: [CODE] }], job: worker('sess_rd_6'), handoff: `plain ${CODE}` },
  {
    name: 'a_task_is_read_as_it_is',
    marks: [{ session: 'sess_rd_7', values: [CODE] }],
    job: { taskId: 't7', sessionId: 'sess_rd_7', view: { task_id: 't7', status: 'completed', type: 'spawn', tag: 'alpha', sessionId: 'sess_rd_7' }, result: `task ${CODE}` },
    handoff: `ignored ${CODE}`,
  },
];
const READ_CONTEXT = { callerSessionId: 'lead1', clientHostPid: 4242, cwd: '/work' };
const read = [];
for (const c of READS) {
  for (const m of c.marks) mark(m);
  const views = {
    getJobOrWorker: () => {
      const { sessionId, ...job } = structuredClone(c.job);
      return { ...job, meta: { sessionId } };
    },
    renderJob: (job) => ({ ...job.view, ...(job.result !== undefined ? { result: job.result } : {}) }),
  };
  const execute = createAgentExecute({
    mgr: { readSessionHandoff: async () => c.handoff },
    defaultCwd: '/work',
    awaitKeychainPrewarm: async () => {},
    registry: { resolveTombstoneOwners() {} },
    views,
    spawnFlow: {},
    sendFlow: {},
    closeFlow: {},
    terminalTrace: null,
  });
  const args = { type: 'read', tag: 'alpha' };
  read.push({ ...c, args, result: await execute(structuredClone(args), { ...READ_CONTEXT }) });
}

// --- room --------------------------------------------------------------------------------------
const ROOM = 'room01';
const ROOM_STEPS = [
  { mark: { session: 'sess_rmem_room01_a', values: [CODE] } },
  {
    post: [
      { id: 'row_1', kind: 'speech', speaker: 'a', text: `the code is ${CODE}`, at: 5 },
      { id: 'row_2', kind: 'speech', speaker: 'b', text: `b says ${CODE}`, at: 6 },
    ],
  },
  { post: [{ id: 'row_3', kind: 'speech', speaker: 'b', text: `b again ${CODE}`, at: 7 }] },
  { mark: { session: 'sess_rmem_room01_b', values: [QUOTED, CODE] } },
  {
    post: [
      { id: 'row_4', kind: 'speech', speaker: 'b', text: `b now ${CODE} and "pa\\"ss"`, at: 8 },
      { id: 'row_5', kind: 'speech', speaker: 'a', text: `a last ${QUOTED}`, at: 9 },
    ],
  },
];
const roomLog = { id: `sess_room_${ROOM}`, messages: [] };
const roomDelivery = createAgentRoomDelivery({ loadSession: () => roomLog, saveSession: async () => {}, live: () => null });
const roomRecords = { [ROOM]: { id: ROOM } };
const log = createRoomLog({ appendRows: (sessionId, rows) => roomDelivery.append(sessionId, rows), readItems: async () => [], republishCatalog: () => {} }, () => roomRecords);
const room = [];
for (const step of ROOM_STEPS) {
  if (step.mark) {
    mark(step.mark);
    room.push(step);
    continue;
  }
  await log.post(ROOM, structuredClone(step.post));
  room.push({
    ...step,
    contents: roomLog.messages.map((message) => message.content),
    rows: (await log.rows(ROOM)).map((row) => row.text),
    preview: roomRecords[ROOM].lastPreview ?? null,
  });
}

// --- home --------------------------------------------------------------------------------------
const LEAD = 'sess_home_lead';
const HOMES = ['sess_home_reviewer', LEAD, 'sess_home_ghost', 'sess_home_critic'];
const HOME_SCRIPT = [
  { op: 'thread', id: LEAD, messages: [{ role: 'user', content: 'hi' }] },
  { op: 'mark', session: 'sess_task_s', values: [CODE] },
  { op: 'mark', session: 'sess_run_s', values: [CODE, QUOTED] },
  { op: 'task', agent: 'lead', report: { runId: 'send_s_end', taskSessionId: 'sess_task_s', title: 'Secret', status: 'completed', text: `the code is ${CODE}\nline two ${CODE}` } },
  { op: 'drain', home: LEAD },
  { op: 'settle', status: 'done' },
  { op: 'drain', home: LEAD },
  { op: 'enqueue', owner: 'lead', name: 'daily', item: { runId: 'run_s', kind: 'schedule', ok: true, text: `ran with ${CODE} and "pa\\"ss"`, runSessionId: 'sess_run_s' } },
  { op: 'drain', home: LEAD },
  { op: 'enqueue', owner: 'lead', name: 'daily', item: { runId: 'run_u', kind: 'schedule', ok: true, text: `kept ${CODE}`, runSessionId: 'sess_run_u' } },
  { op: 'drain', home: LEAD },
  { op: 'busy', value: true },
  { op: 'task', agent: 'lead', report: { runId: 'send_p_progress_turn_1', taskSessionId: 'sess_task_s', title: 'Secret', status: 'working', text: `working on ${CODE}` } },
  { op: 'task', agent: 'lead', report: { runId: 'send_p_end', taskSessionId: 'sess_task_s', title: 'Secret', status: 'completed', text: `done with ${CODE}`, progressRunId: 'send_p_progress_turn_1' } },
  { op: 'busy', value: false },
  { op: 'drain', home: LEAD },
  { op: 'settle', status: 'done' },
  { op: 'drain', home: LEAD },
];
const sessions = new Map();
const notices = [];
const wakes = [];
const retries = [];
const scheduled = [];
const turns = [];
const ctl = { busy: false };
let inFlight = 0;
const queuePath = join(dir, 'routine-results.json');
const queue = createRoutineResultQueue(queuePath, { limit: 200, now: () => clock });
// Queue calls in flight (a durable write can take a while) keep the step open.
for (const key of Object.keys(queue)) {
  const fn = queue[key];
  if (typeof fn !== 'function') continue;
  queue[key] = async (...callArgs) => {
    inFlight += 1;
    try {
      return await fn(...callArgs);
    } finally {
      inFlight -= 1;
    }
  };
}
const delivery = createAgentHomeDelivery({
  loadSession: (id) => sessions.get(id) || null,
  saveSession: async () => {},
  turnInFlight: () => ctl.busy,
  queue,
  live: () => ({
    busy: () => false,
    notice: (id, notice) => {
      notices.push([id, notice]);
      return true;
    },
    wake: async (id, prompt, options) => {
      wakes.push([id, prompt, options]);
      let settle;
      const settled = new Promise((resolve) => (settle = resolve));
      turns.push(settle);
      return { settled };
    },
  }),
  retryLater: (fn, ms) => {
    scheduled.push(ms);
    retries.push({ fn, ms });
  },
  agentPresence: () => 'unknown',
  homeAgent: () => 'unknown',
  mixyExists: async () => true,
  log: () => {},
});
const readQueue = () => {
  try {
    return JSON.parse(readFileSync(queuePath, 'utf8'));
  } catch {
    return null;
  }
};
// Background passes (a settled wake) finish on their own: wait until nothing moves.
const fingerprint = () => JSON.stringify([readQueue(), notices.length, wakes.length, scheduled.length, [...sessions].map(([, s]) => s.messages.length)]);
async function stable() {
  let last = null;
  for (let same = 0; same < 5; ) {
    await sleep(25);
    const now = fingerprint();
    same = now === last && inFlight === 0 ? same + 1 : 0;
    last = now;
  }
}
const home = [];
for (const o of HOME_SCRIPT) {
  let out = null;
  const before = { notices: notices.length, wakes: wakes.length, scheduled: scheduled.length };
  switch (o.op) {
    case 'thread':
      sessions.set(o.id, { id: o.id, messages: structuredClone(o.messages), generation: 1 });
      break;
    case 'mark':
      mark(o);
      break;
    case 'task':
      out = await delivery.enqueueTask(o.agent, structuredClone(o.report));
      break;
    case 'enqueue':
      out = await delivery.enqueue({ name: o.name, ownerAgentId: o.owner }, structuredClone(o.item));
      break;
    case 'drain':
      await delivery.drain(o.home);
      break;
    case 'busy':
      ctl.busy = o.value;
      break;
    case 'settle':
      turns.shift()?.(o.status);
      await new Promise((resolve) => setImmediate(resolve));
      break;
    default:
      throw new Error(`unknown op ${o.op}`);
  }
  // As record-home-delivery.mjs: every home drained twice, so the snapshot is the same wherever a pass was scheduled.
  for (let round = 0; round < 2; round += 1) await Promise.all(HOMES.map((h) => delivery.drain(h)));
  await stable();
  home.push({
    op: o,
    out: plain(out),
    queue: plain(readQueue()),
    threads: plain(Object.fromEntries([...sessions].map(([id, s]) => [id, s.messages]))),
    notices: plain(notices.slice(before.notices)),
    wakes: plain(wakes.slice(before.wakes)),
    delays: scheduled.slice(before.scheduled),
  });
}

const recorded = JSON.stringify({ read, room, home });
if (!recorded.includes('[redacted]')) throw new Error('nothing was redacted: the tree lacks the gaps patch');

const finalDir = join(FIXTURES_ROOT, 'sensitive-gaps');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), {
  note: 'the agent tool read of a worker, a member speech posted into a room and a task report or routine result reaching a home, from Node b6f10295a with the sensitive-value patches, with values marked sensitive in the session the text leaves; a mark is a browser fill with sensitive:true whose fields are the values; home time is frozen at 1800000000000 and its wake ids come from a counter',
  read,
  room,
  home,
});
const patches = identity.patches.map((p) => `benchmarks/rust-core/recorders/node-patches/${p.file}`);
writeSetManifest(stage, {
  set: 'sensitive-gaps',
  recorder,
  command: `node ${recorder} --tree <export of ${NODE_COMMIT} with the patches applied> --patch ${patches.join(',')}`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url, patches),
    recorded: { tree: `export of ${NODE_COMMIT} with ${identity.patches.map((p) => `${p.file} (sha256 ${p.sha256})`).join(', then ')} applied` },
    compared: 'read: the rendered answer; room: after each post the log message contents, the rows shown and the list preview; home: after each operation the queue file, the threads, the notices, the wakes and the retry delays',
  },
});
commitStage(stage, finalDir);
console.log(`read=${read.length} room=${room.length} home=${home.length}`);
process.exit(0);
