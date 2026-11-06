#!/usr/bin/env node
// Genuine 1.4.5 behaviour of the agent home-chat delivery queue: Node's own
// createAgentHomeDelivery over a real createRoutineResultQueue file
// (`routine-results.json`), driven by a script of operations. After every operation the recorder
// stores what the delivery left: the queue file, every home thread's messages, the live notices
// and the wake turns it asked for. The Rust AgentHomeDelivery replays the same script over its own
// fixtures and must leave the same values once generated wake ids are masked as <uuid>.
//
//   node benchmarks/rust-core/recorders/record-home-delivery.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/home-delivery/golden.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const dir = mkdtempSync(join(tmpdir(), 'home-delivery-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const { createAgentHomeDelivery, createRoutineResultQueue } = await importFrom(tree, 'src/session-runtime/agent-home-delivery.mjs');

const T0 = 1_800_000_000_000;
let clock = T0;
Date.now = () => clock;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const mask = (value) => JSON.parse(JSON.stringify(value ?? null).replace(UUID, '<uuid>'));

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
// queue overflow past the limit leaves one omitted notice
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
const turns = [];
const ctl = { busy: false, refuse: 0, presence: {}, homeAgents: {}, mixy: true };
let queue;
let delivery;

function build(limit) {
  const path = join(dir, 'routine-results.json');
  queue = createRoutineResultQueue(path, { limit, now: () => clock });
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
    retryLater: (fn, ms) => retries.push({ fn, ms }),
    agentPresence: (id) => ctl.presence[id] || 'unknown',
    homeAgent: (id) => ctl.homeAgents[id] || 'unknown',
    mixyExists: async () => ctl.mixy,
    log: () => {},
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
const steps = [];
for (const o of script) {
  let out = null;
  const before = { notices: notices.length, wakes: wakes.length };
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
  for (let round = 0; round < 2; round += 1) await Promise.all(HOMES.map((home) => delivery.drain(home)));
  steps.push({
    op: o,
    out: mask(out),
    queue: mask(readQueue()),
    threads: mask(Object.fromEntries([...sessions].map(([id, s]) => [id, s.messages]))),
    notices: mask(notices.slice(before.notices)),
    wakes: mask(wakes.slice(before.wakes)),
  });
}

const finalOut = join(FIXTURES_ROOT, 'home-delivery');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'agent home delivery steps of the real 1.4.5 createAgentHomeDelivery over a real routine-results.json; time is frozen at 1800000000000 (+ the time ops) and generated wake ids are masked as <uuid>',
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
