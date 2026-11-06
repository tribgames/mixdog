#!/usr/bin/env node
// Golden twin of the daemon's quota-resume store (runtime/shared/quota-resume-store.mjs): the
// durable queue of Lead turns waiting for their provider quota to reset, with the Goal
// suspensions and the generation guard. Node's real store runs scripted operation sequences over
// an isolated data directory; each operation records its answer, the change notifications it
// raised and the exact text of the file afterwards. Rust `mixdog_core::quota_resume` must equal
// it (answers, notifications, file bytes), including how a damaged file loads.
//
//   node benchmarks/rust-core/recorders/record-quota-resume.mjs --tree <dir>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const store = await importFrom(tree, 'src/runtime/shared/quota-resume-store.mjs');

let seed = 0x51a07a11;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const SESSIONS = ['sess_a', 'sess_b', ' sess_c ', 'sess_a', ''];
const TURNS = ['turn:a-user', 'turn:b-user', 'turn:c', ' turn:d ', ''];
const PROVIDERS = ['openai-oauth', 'anthropic', ' gemini ', ''];
const RESETS = [1000, 5000, 9000.5, 0, -1, null, 'x', true, undefined];
const MODELS = ['gpt-x', '', ' padded ', undefined, 7];
const GOALS = ['goal-1', 'goal-2', ' goal-3 ', ''];

function randomScheduleArgs() {
  const args = {};
  const set = (key, value) => {
    if (value !== undefined) args[key] = value;
  };
  set('sessionId', chance(0.9) ? pick(SESSIONS.slice(0, 4)) : pick(SESSIONS));
  set('turnKey', chance(0.9) ? pick(TURNS.slice(0, 4)) : pick(TURNS));
  set('provider', chance(0.9) ? pick(PROVIDERS.slice(0, 3)) : pick(PROVIDERS));
  set('model', pick(MODELS));
  set('resetAt', chance(0.85) ? pick([1000, 5000, 9000.5, 0, -1]) : pick(RESETS));
  if (chance(0.5)) set('routeProvider', pick(['openai-oauth', '', 3]));
  if (chance(0.5)) set('routeModel', pick(['gpt-x', '', 'm']));
  return args;
}

const dirs = [];
function isolate() {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-quota-resume-twin-'));
  dirs.push(dir);
  process.env.MIXDOG_DATA_DIR = dir;
  process.env.MIXDOG_CONFIG_DIR = dir;
  process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
  store.reloadQuotaResumeStore();
  return dir;
}

const readFile = (dir) => {
  try {
    return readFileSync(join(dir, store.QUOTA_RESUME_FILE), 'utf8');
  } catch {
    return null;
  }
};

function run(op, args) {
  switch (op) {
    case 'schedule':
      return store.scheduleQuotaResumeEntry(args);
    case 'cancel':
      return store.cancelQuotaResumeEntry(args.sessionId, args.generation === undefined ? {} : { generation: args.generation });
    case 'defer':
      return store.deferQuotaResumeEntry(args.sessionId, args.generation, { resetAt: args.resetAt, attempts: args.attempts });
    case 'cancelAll':
      return store.cancelAllQuotaResumeEntries();
    case 'noteGoal':
      return store.noteQuotaSuspendedGoal(args.sessionId, args.turnKey, args.goalId);
    case 'forgetGoal':
      return store.forgetQuotaSuspendedGoal(args.sessionId);
    case 'goal':
      return store.quotaSuspendedGoal(args.sessionId, args.turnKey);
    case 'rekey':
      return store.rekeyQuotaResumeTurn(args.sessionId, args.from, args.to);
    case 'entry':
      return store.quotaResumeEntry(args.sessionId);
    case 'list':
      return store.listQuotaResumeEntries();
    case 'public':
      return store.publicQuotaResume(store.quotaResumeEntry(args.sessionId));
    case 'restart':
      store.reloadQuotaResumeStore();
      return null;
    default:
      throw new Error(op);
  }
}

// Scripts a sequence: each step's arguments may name generations seen so far.
function script(length) {
  const steps = [];
  // What the store holds if every scheduled entry was valid: the names a later step may use so
  // that its generation or turn matches (or, by chance, does not).
  const held = new Map();
  let counter = 0;
  const trim = (v) => (typeof v === 'string' ? v.trim() : '');
  for (let i = 0; i < length; i += 1) {
    const op = pick(['schedule', 'schedule', 'schedule', 'cancel', 'cancel', 'defer', 'defer', 'cancelAll', 'noteGoal', 'noteGoal', 'forgetGoal', 'goal', 'rekey', 'rekey', 'entry', 'list', 'public', 'restart']);
    const sessionId = pick(SESSIONS);
    const entry = held.get(trim(sessionId));
    const generation = () => (entry && chance(0.7) ? entry.generation : pick([0, 1, 2, 99, null]));
    let args = {};
    if (op === 'schedule') args = randomScheduleArgs();
    else if (op === 'cancel') args = { sessionId, ...(chance(0.5) ? { generation: generation() } : {}) };
    else if (op === 'defer') args = { sessionId, generation: generation(), resetAt: chance(0.6) ? pick([2000, 7000.5]) : pick(RESETS), attempts: chance(0.6) ? pick([0, 1, 2]) : pick([-1, 1.5, null, undefined]) };
    else if (op === 'noteGoal') args = { sessionId, turnKey: entry && chance(0.6) ? entry.turnKey : pick(TURNS), goalId: pick(GOALS) };
    else if (op === 'forgetGoal' || op === 'entry' || op === 'public') args = { sessionId };
    else if (op === 'goal') args = { sessionId, turnKey: entry && chance(0.6) ? entry.turnKey : pick(TURNS) };
    else if (op === 'rekey') args = { sessionId, from: entry && chance(0.7) ? entry.turnKey : pick(TURNS), to: pick(TURNS) };
    steps.push({ op, args: plain(args), liveArgs: args });
    if (op === 'schedule') {
      const valid = trim(args.sessionId) && trim(args.turnKey) && trim(args.provider) && typeof args.resetAt === 'number' && Number.isFinite(args.resetAt);
      if (valid) {
        counter = Math.max(counter, ...[...held.values()].map((e) => e.generation)) + 1;
        held.set(trim(args.sessionId), { generation: counter, turnKey: trim(args.turnKey) });
      }
    } else if (op === 'cancel' && entry && (args.generation === undefined || args.generation === entry.generation)) {
      held.delete(trim(sessionId));
    } else if (op === 'cancelAll') {
      held.clear();
    } else if (op === 'rekey' && entry && args.from === entry.turnKey) {
      entry.turnKey = trim(args.to) || entry.turnKey;
    }
  }
  return steps;
}

const cases = [];

function record(name, preFile, steps) {
  const dir = isolate();
  if (preFile !== null) writeFileSync(join(dir, store.QUOTA_RESUME_FILE), preFile);
  let events = [];
  const unsubscribe = store.subscribeQuotaResume((id) => events.push(id));
  const out = [];
  // `file` is the text after the step; omitted while it is what the step before left.
  let previous = preFile;
  for (const step of steps) {
    events = [];
    let result;
    try {
      result = { value: plain(run(step.op, step.liveArgs ?? step.args)) };
    } catch (error) {
      result = { error: `${error?.name}: ${error?.message}` };
    }
    const file = readFile(dir);
    out.push({ op: step.op, args: step.args, ...result, events: plain(events), ...(file === previous ? {} : { file }) });
    previous = file;
  }
  unsubscribe();
  cases.push({ name, preFile, steps: out });
}

// Sequences from a clean directory.
for (let i = 0; i < 200; i += 1) record(`script ${i}`, null, script(26));

// Loading a file Node did not write itself: damaged, hand-edited, or from an older run.
const goodEntry = { sessionId: 'sess_a', turnKey: 'turn:a', provider: 'openai-oauth', model: 'gpt-x', resetAt: 5000, attempts: 1, generation: 3, routeProvider: '', routeModel: '' };
const goodSuspension = { sessionId: 'sess_a', turnKey: 'turn:a', goalId: 'goal-1' };
const files = [
  ['empty file', ''],
  ['torn json', '{"version":1,"entries":['],
  ['not an object', '[1,2]'],
  ['bom', `\ufeff${JSON.stringify({ version: 1, generation: 4, entries: [goodEntry], suspensions: [goodSuspension] })}`],
  ['plain', JSON.stringify({ version: 1, generation: 4, entries: [goodEntry], suspensions: [goodSuspension] })],
  ['generation only', JSON.stringify({ generation: 9 })],
  ['generation unsafe', JSON.stringify({ generation: 1.5, entries: [goodEntry] })],
  ['generation negative', JSON.stringify({ generation: -4, entries: [{ ...goodEntry, generation: 2 }] })],
  ['entries not array', JSON.stringify({ entries: { a: 1 }, suspensions: 'x' })],
  ['duplicate sessions', JSON.stringify({ entries: [goodEntry, { ...goodEntry, generation: 7, provider: 'anthropic' }, { ...goodEntry, sessionId: 'sess_b', generation: 2 }] })],
  ['trimmed names', JSON.stringify({ entries: [{ ...goodEntry, sessionId: ' sess_a ', turnKey: ' t ', provider: ' p ' }] })],
  ['bad attempts', JSON.stringify({ entries: [{ ...goodEntry, attempts: -1 }, { ...goodEntry, sessionId: 'b', attempts: 1.5 }, { ...goodEntry, sessionId: 'c', attempts: '3' }, { ...goodEntry, sessionId: 'd', attempts: 2.0 }] })],
  ['bad entries dropped', JSON.stringify({ entries: [{ ...goodEntry, generation: 0 }, { ...goodEntry, sessionId: 'b', generation: 1.5 }, { ...goodEntry, sessionId: 'c', resetAt: '5' }, { ...goodEntry, sessionId: 'd', provider: '' }, { ...goodEntry, sessionId: 'e', turnKey: ' ' }, null, 4, 'x', { ...goodEntry, sessionId: '' }, { ...goodEntry, sessionId: 'f' }] })],
  ['route fields', JSON.stringify({ entries: [{ ...goodEntry, routeProvider: 4, routeModel: null, model: 3 }] })],
  ['suspensions', JSON.stringify({ suspensions: [goodSuspension, { ...goodSuspension, goalId: 'g2' }, { ...goodSuspension, sessionId: 'b', goalId: '' }, { sessionId: 'c', turnKey: 't', goalId: ' g ' }, 7] })],
  ['extra keys', JSON.stringify({ version: 9, other: true, entries: [{ ...goodEntry, extra: 1 }] })],
];
for (const [name, text] of files) {
  record(`load ${name}`, text, [
    { op: 'list', args: {} },
    { op: 'goal', args: { sessionId: 'sess_a', turnKey: 'turn:a' } },
    { op: 'schedule', args: { sessionId: 'sess_z', turnKey: 'turn:z', provider: 'p', resetAt: 1 } },
    { op: 'rekey', args: { sessionId: 'sess_a', from: 'turn:a', to: 'turn:b' } },
    { op: 'restart', args: {} },
    { op: 'list', args: {} },
  ]);
}

// Which sessions never own a quota resume.
const agentOnly = [];
const sessions = [
  null, undefined, 'x', 7, {}, { id: 's' },
  { visibility: 'agent-only' }, { visibility: ' AGENT-ONLY ' }, { visibility: 'public' },
  { owner: 'agent', agent: 'worker', parentSessionId: 'p', id: 's' },
  { owner: 'AGENT', agent: 'Worker', ownerSessionId: 'p', id: 's' },
  { owner: 'agent', agent: 'lead', parentSessionId: 'p', id: 's' },
  { owner: 'agent', agent: ' LEAD ', parentSessionId: 'p', id: 's' },
  { owner: 'agent', agent: 'worker', id: 's' },
  { owner: 'agent', agent: 'worker', parentSessionId: 's', id: 's' },
  { owner: 'agent', agent: 'worker', parentSessionId: ' s ', id: ' s ' },
  { owner: 'agent', agent: 'worker', parentSessionId: '', ownerSessionId: 'p', id: 's' },
  { owner: 'user', agent: 'worker', parentSessionId: 'p', id: 's' },
  { owner: 'agent', parentSessionId: 'p', id: 's' },
  { owner: 'agent', agent: 'worker', parentSessionId: 5, id: 's' },
  { owner: 'agent', agent: 'worker', parentSessionId: ' ', ownerSessionId: 'p', id: 's' },
  { owner: 'agent', agent: 'worker', parentSessionId: 0, ownerSessionId: 'p', id: 's' },
  { owner: 'agent', agent: 'worker', parentSessionId: null, ownerSessionId: 'p', id: 5 },
  { owner: 'agent', agent: 'worker', parentSessionId: true, id: 's' },
  [],
];
for (const session of sessions) agentOnly.push({ session: plain(session), agentOnly: store.isAgentOnlySession(session) });

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'quota-resume-twin.json'), {
  domain: 'quota-resume-twin',
  recorder: 'benchmarks/rust-core/recorders/record-quota-resume.mjs',
  cases,
  agentOnly,
});
writeSetManifest(outDir, {
  set: 'ai-admin',
  recorder: 'benchmarks/rust-core/recorders/record-quota-resume.mjs',
  command: 'node benchmarks/rust-core/recorders/record-quota-resume.mjs --tree <tree>',
  identityTree: tree,
});
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
const ops = cases.flatMap((c) => c.steps);
console.log(`recorded ${cases.length} cases, ${ops.length} operations (${ops.filter((o) => o.error).length} errors)`);
