#!/usr/bin/env node
// Genuine 1.4.5 behaviour of the agent home-chat delivery queue: Node's own
// createAgentHomeDelivery over a real createRoutineResultQueue file
// (`routine-results.json`), driven by a script of operations. After every operation the recorder
// stores what the delivery left: the queue file, every home thread's messages, the live notices
// and the wake turns it asked for. The Rust AgentHomeDelivery replays the same script over its own
// fixtures and must leave the same values, wake ids included: Node's crypto.randomUUID is replaced by
// a counter here, and the Rust queue's id source by the same counter, so ids compare exactly.
//
//   node benchmarks/rust-core/recorders/record-home-delivery.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/home-delivery/golden.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodeCrypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const dir = mkdtempSync(join(tmpdir(), 'home-delivery-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// The delivery draws its wake batch ids from crypto.randomUUID: a counter makes them repeatable.
let uuidCounter = 0;
nodeCrypto.randomUUID = () => `00000000-0000-4000-8000-${(++uuidCounter).toString(16).padStart(12, '0')}`;
syncBuiltinESMExports();

const { createAgentHomeDelivery, createRoutineResultQueue } = await importFrom(tree, 'src/session-runtime/agent-home-delivery.mjs');

const T0 = 1_800_000_000_000;
let clock = T0;
Date.now = () => clock;

const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LEAD = 'sess_home_lead';
const script = [];
const op = (o) => script.push(o);

// --- the script -----------------------------------------------------------------------------
op({ op: 'config', limit: 4 });
op({ op: 'enqueue', owner: 'reviewer', name: 'new-issues', item: { runId: 'run_1', kind: 'schedule', ok: true, text: 'Two new issues:\n#12 and #13', runSessionId: 'sess_run_1' } });
op({ op: 'drain', home: 'sess_home_reviewer' });
op({ op: 'thread', id: 'sess_home_reviewer', messages: [{ role: 'user', content: 'hi' }] });
op({ op: 'fire' });
op({ op: 'enqueue', owner: 'reviewer', name: 'hook', item: { runId: 'run_2', kind: 'webhook', ok: false, text: 'boom', reason: 'timeout', paused: true } });
op({ op: 'drain', home: 'sess_home_reviewer' });
op({ op: 'enqueue', owner: 'reviewer', name: 'hook', item: { runId: 'run_2', kind: 'webhook', ok: false, text: 'again' } });
op({ op: 'drain', home: 'sess_home_reviewer' });
op({ op: 'thread', id: LEAD, messages: [{ role: 'user', content: 'hi' }] });
op({ op: 'held', agent: 'lead', held: { id: 'h1', status: 'pending', kind: 'approval', summary: 'Run rm -rf?' } });
op({ op: 'drain', home: LEAD });
op({ op: 'message', agent: 'lead', runId: 'hb_1', text: '  Heartbeat found two items.  ' });
op({ op: 'drain', home: LEAD });
op({ op: 'busy', value: true });
op({ op: 'enqueue', owner: 'lead', name: 'nightly', item: { runId: 'run_busy', kind: 'schedule', ok: true, text: 'busy one' } });
op({ op: 'held', agent: 'lead', held: { id: 'h2', status: 'pending', kind: 'approval', summary: 'Second?' } });
op({ op: 'drain', home: LEAD });
op({ op: 'before', home: LEAD });
op({ op: 'busy', value: false });
op({ op: 'fire' });
op({ op: 'drain', home: LEAD });
// task reports: quiet, then a final one waking the agent
op({ op: 'task', agent: 'lead', report: { runId: 'send_1_started', taskSessionId: 'sess_task_1', title: 'Parser', status: 'started', text: 'Starting', watchId: 'w1' } });
op({ op: 'drain', home: LEAD });
op({ op: 'task', agent: 'lead', report: { runId: 'send_1_end', taskSessionId: 'sess_task_1', title: 'Parser', status: 'completed', text: 'All done.\nSecond line', target: 'session', watchId: 'w1', files: [{ path: 'a.txt', name: 'a.txt' }], omitted: 2, hop: 1 } });
op({ op: 'drain', home: LEAD });
op({ op: 'settle', status: 'failed' });
op({ op: 'drain', home: LEAD });
op({ op: 'time', ms: 40_000 });
op({ op: 'fire' });
op({ op: 'drain', home: LEAD });
op({ op: 'settle', status: 'done' });
op({ op: 'drain', home: LEAD });
// progress then its final report: the answer posts once
op({ op: 'busy', value: true });
op({ op: 'task', agent: 'lead', report: { runId: 'send_2_progress_turn_1', taskSessionId: 'sess_task_2', title: 'Parser2', status: 'working', text: 'All done.' } });
op({ op: 'task', agent: 'lead', report: { runId: 'send_2_end', taskSessionId: 'sess_task_2', title: 'Parser2', status: 'completed', text: 'All done.', progressRunId: 'send_2_progress_turn_1' } });
op({ op: 'busy', value: false });
op({ op: 'fire' });
op({ op: 'drain', home: LEAD });
op({ op: 'settle', status: 'done' });
op({ op: 'drain', home: LEAD });
// wake refusals
op({ op: 'refuseWakes', count: 1 });
op({ op: 'task', agent: 'lead', report: { runId: 'send_3_end', taskSessionId: 'sess_task_3', title: 'Third', status: 'completed', text: 'third' } });
op({ op: 'drain', home: LEAD });
op({ op: 'fire' });
op({ op: 'drain', home: LEAD });
op({ op: 'settle', status: 'done' });
op({ op: 'drain', home: LEAD });
// wake retries: a relay turn that never finishes is tried again after 30s, 120s, 600s, then given up
op({ op: 'extraDrains', value: false });
op({ op: 'task', agent: 'lead', report: { runId: 'send_r1_end', taskSessionId: 'sess_task_r1', title: 'Retry', status: 'completed', text: 'retry me' } });
op({ op: 'drain', home: LEAD });
for (const wait of [30_000, 120_000, 600_000]) {
  op({ op: 'settle', status: 'failed' });
  op({ op: 'drain', home: LEAD });
  op({ op: 'fire' });
  op({ op: 'drain', home: LEAD });
  op({ op: 'time', ms: wait - 1 });
  op({ op: 'fire' });
  op({ op: 'drain', home: LEAD });
  op({ op: 'time', ms: 1 });
  op({ op: 'fire' });
  op({ op: 'drain', home: LEAD });
}
op({ op: 'settle', status: 'failed' });
op({ op: 'drain', home: LEAD });
op({ op: 'fire' });
op({ op: 'drain', home: LEAD });
// wake refusals: the 10th submission of one batch is the last; 9 refusals then an accepted wake
op({ op: 'refuseWakes', count: 9 });
op({ op: 'task', agent: 'lead', report: { runId: 'send_f1_end', taskSessionId: 'sess_task_f1', title: 'Refused nine', status: 'completed', text: 'nine refusals' } });
op({ op: 'drain', home: LEAD });
for (let i = 0; i < 9; i += 1) op({ op: 'fire' });
op({ op: 'settle', status: 'done' });
op({ op: 'drain', home: LEAD });
// 10 refusals: given up with a note, nobody woken
op({ op: 'refuseWakes', count: 10 });
op({ op: 'task', agent: 'lead', report: { runId: 'send_f2_end', taskSessionId: 'sess_task_f2', title: 'Refused ten', status: 'completed', text: 'ten refusals' } });
op({ op: 'drain', home: LEAD });
for (let i = 0; i < 10; i += 1) op({ op: 'fire' });
op({ op: 'drain', home: LEAD });
op({ op: 'extraDrains', value: true });// queue overflow past the limit leaves one omitted notice
op({ op: 'busy', value: true });
for (let i = 1; i <= 6; i += 1) op({ op: 'message', agent: 'lead', runId: `hb_over_${i}`, text: `over ${i}` });
op({ op: 'busy', value: false });
op({ op: 'drain', home: LEAD });
// bookkeeping
op({ op: 'watch', watch: { runId: 'w_a', homeSessionId: LEAD, taskSessionId: 'sess_task_9', title: 'Nine' } });
op({ op: 'follow', runId: 'w_a', submissionId: 'sub_9' });
op({ op: 'own', work: { runId: 'own_1', homeSessionId: LEAD, taskSessionId: 'sess_task_9' } });
op({ op: 'watches' });
op({ op: 'owned' });
op({ op: 'unwatch', runId: 'w_a' });
op({ op: 'disown', runIds: ['own_1'] });
op({ op: 'reset', home: LEAD });
// deleted owner moves to Mixy; non-bot homes drop; room log drops; heartbeat drop
op({ op: 'presence', agents: { ghost: 'deleted' } });
op({ op: 'enqueue', owner: 'ghost', name: 'orphan', item: { runId: 'run_ghost', kind: 'schedule', ok: true, text: 'orphan result' } });
op({ op: 'drain', home: 'sess_home_ghost' });
op({ op: 'homeAgents', agents: { critic: 'none' } });
op({ op: 'enqueue', owner: 'critic', name: 'x', item: { runId: 'run_critic', kind: 'schedule', ok: true, text: 'nobody home' } });
op({ op: 'drain', home: 'sess_home_critic' });
op({ op: 'mixyExists', value: false });
op({ op: 'message', agent: 'lead', runId: 'hb_gone', text: 'report for a Mixy that is not there' });
op({ op: 'drain', home: LEAD });
op({ op: 'recover' });
op({ op: 'announce', owner: 'lead', name: 'nightly', run: { runId: 'run_live', kind: 'schedule', ok: true, runSessionId: 'sess_run_live', state: 'running' } });
op({ op: 'announce', owner: 'lead', name: 'hook', run: { runId: 'run_lost', kind: 'webhook', ok: false, state: 'undelivered' } });
op({ op: 'busy', value: true });
op({ op: 'announce', owner: 'lead', name: 'hook', run: { runId: 'run_lost', kind: 'webhook', ok: false, state: 'undelivered' } });

// --- the replay -----------------------------------------------------------------------------
const sessions = new Map();
const notices = [];
const wakes = [];
const retries = [];
const scheduled = [];
const turns = [];
const ctl = { extraDrains: true, busy: false, refuse: 0, presence: {}, homeAgents: {}, mixy: true };
let queue;
let delivery;
let inFlight = 0;

function build(limit) {
  const path = join(dir, 'routine-results.json');
  queue = createRoutineResultQueue(path, { limit, now: () => clock });
  // Queue calls in flight (a durable write can take a while) keep the step open.
  for (const key of Object.keys(queue)) {
    const fn = queue[key];
    if (typeof fn !== 'function') continue;
    queue[key] = async (...args) => {
      inFlight += 1;
      try {
        return await fn(...args);
      } finally {
        inFlight -= 1;
      }
    };
  }
  delivery = createAgentHomeDelivery({
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
        if (ctl.refuse > 0) {
          ctl.refuse -= 1;
          return false;
        }
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
    agentPresence: (id) => ctl.presence[id] || 'unknown',
    homeAgent: (id) => ctl.homeAgents[id] || 'unknown',
    mixyExists: async () => ctl.mixy,
    log: (m) => { if (process.env.HD_LOG) console.error('step ' + steps.length + ': ' + m); },
  });
  return path;
}

let queuePath = build(200);
const readQueue = () => {
  try {
    return JSON.parse(readFileSync(queuePath, 'utf8'));
  } catch {
    return null;
  }
};

const HOMES = ['sess_home_reviewer', LEAD, 'sess_home_ghost', 'sess_home_critic'];
// Background passes (a fired retry, a settled wake) finish on their own: wait until nothing moves.
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
const steps = [];
for (const o of script) {
  let out = null;
  const before = { notices: notices.length, wakes: wakes.length, scheduled: scheduled.length };
  switch (o.op) {
    case 'config':
      queuePath = build(o.limit);
      break;
    case 'enqueue':
      out = await delivery.enqueue({ name: o.name, ownerAgentId: o.owner }, o.item);
      break;
    case 'held':
      out = await delivery.enqueueHeld(o.agent, o.held);
      break;
    case 'message':
      out = await delivery.enqueueMessage(o.agent, { runId: o.runId, text: o.text });
      break;
    case 'task':
      out = await delivery.enqueueTask(o.agent, o.report);
      break;
    case 'drain':
      await delivery.drain(o.home);
      break;
    case 'before':
      await delivery.postBeforeTurn(o.home);
      break;
    case 'thread':
      sessions.set(o.id, { id: o.id, messages: structuredClone(o.messages), generation: 1 });
      break;
    case 'extraDrains':
      ctl.extraDrains = o.value;
      break;
    case 'busy':
      ctl.busy = o.value;
      break;
    case 'refuseWakes':
      ctl.refuse = o.count;
      break;
    case 'presence':
      ctl.presence = o.agents;
      break;
    case 'homeAgents':
      ctl.homeAgents = o.agents;
      break;
    case 'mixyExists':
      ctl.mixy = o.value;
      break;
    case 'time':
      clock += o.ms;
      break;
    case 'fire': {
      const due = retries.splice(0);
      for (const retry of due) retry.fn();
      await new Promise((resolve) => setImmediate(resolve));
      break;
    }
    case 'settle':
      // Settles the oldest wake turn not settled yet, with status; nothing when none is open.
      turns.shift()?.(o.status);
      await new Promise((resolve) => setImmediate(resolve));
      break;
    case 'watch':
      out = await delivery.watchTask(structuredClone(o.watch));
      break;
    case 'follow':
      await delivery.followTask(o.runId, o.submissionId);
      break;
    case 'unwatch':
      await delivery.unwatchTask(o.runId);
      break;
    case 'own':
      await delivery.ownTask(structuredClone(o.work));
      break;
    case 'disown':
      for (const id of o.runIds) await delivery.disownTask(id);
      break;
    case 'watches':
      out = await delivery.taskWatches();
      break;
    case 'owned':
      out = await delivery.ownedTasks();
      break;
    case 'reset':
      await delivery.resetRounds(o.home);
      break;
    case 'recover':
      await delivery.recover();
      break;
    case 'announce':
      out = await delivery.announce({ name: o.name, ownerAgentId: o.owner }, o.run);
      break;
    default:
      throw new Error(`unknown op ${o.op}`);
  }
  // A drain started in the background (a moved result, a settled wake) is waited for, so the snapshot is
  // the same wherever the pass was scheduled.
  if (ctl.extraDrains) for (let round = 0; round < 2; round += 1) await Promise.all(HOMES.map((home) => delivery.drain(home)));
  await stable();
  steps.push({
    op: o,
    out: plain(out),
    queue: plain(readQueue()),
    threads: plain(Object.fromEntries([...sessions].map(([id, s]) => [id, s.messages]))),
    notices: plain(notices.slice(before.notices)),
    wakes: plain(wakes.slice(before.wakes)),
    delays: scheduled.slice(before.scheduled),
  });
}

const finalOut = join(FIXTURES_ROOT, 'home-delivery');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'agent home delivery steps of the real 1.4.5 createAgentHomeDelivery over a real routine-results.json; time is frozen at 1800000000000 (+ the time ops) and wake ids come from a counter',
  steps,
});
writeSetManifest(out, {
  set: 'home-delivery',
  recorder: 'benchmarks/rust-core/recorders/record-home-delivery.mjs',
  command: 'node benchmarks/rust-core/recorders/record-home-delivery.mjs --tree <tree>',
  extra: { steps: steps.length },
});
commitStage(out, finalOut);
console.log(`steps=${steps.length}`);
