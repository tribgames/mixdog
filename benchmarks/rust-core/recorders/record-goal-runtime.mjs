#!/usr/bin/env node
// Golden twin of the Goal runtime (runtime-core/goal-*.mjs and goal-recovery.mjs): Node's real
// `createGoalRuntime` runs scripted operation sequences over an isolated data directory under a
// fake clock and fake timers. Each step records its answer (or error text), the listener events it
// raised, the live deadline timers it left and the exact text of every file under `goals/`
// afterwards. Rust `mixdog_core::goal` must equal it, tool actions and refusal texts, storage
// bytes, recovery and continuation prompts included.
//
//   node benchmarks/rust-core/recorders/record-goal-runtime.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);

// Timers the Goal runtime arms are driven by the script: deadlines, warnings, the heartbeat and the
// title timeout are held here and fired by `advance`; the file cache's re-read debounce fires when
// a step settles. Every other timer is the real one (file locks sleep on them).
const T0 = 1_800_000_000_000;
let clock = T0;
let mono = 5_000;
const fakeTimers = new Map();
let timerSeq = 0;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const kindOfCaller = () => {
  const stack = new Error().stack ?? '';
  if (stack.includes('goal-deadlines.mjs')) return 'goal';
  if (stack.includes('goal-title.mjs')) return 'title';
  if (stack.includes('watched-file-cache.mjs')) return 'cache';
  return null;
};
const fake = (kind, fn, ms, interval) => {
  const timer = { id: ++timerSeq, kind, fn, due: clock + Math.max(0, Number(ms) || 0), interval: interval ? Math.max(1, Number(ms) || 1) : 0, unref() {}, ref() {} };
  fakeTimers.set(timer.id, timer);
  return timer;
};
globalThis.setTimeout = (fn, ms, ...rest) => {
  const kind = kindOfCaller();
  return kind ? fake(kind, () => fn(...rest), ms, false) : realSetTimeout(fn, ms, ...rest);
};
globalThis.setInterval = (fn, ms, ...rest) => {
  const kind = kindOfCaller();
  return kind ? fake(kind, () => fn(...rest), ms, true) : realSetInterval(fn, ms, ...rest);
};
const clearFake = (timer, real) => (timer && typeof timer === 'object' && 'due' in timer ? void fakeTimers.delete(timer.id) : real(timer));
globalThis.clearTimeout = (timer) => clearFake(timer, realClearTimeout);
globalThis.clearInterval = (timer) => clearFake(timer, realClearInterval);
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const runtimeModule = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/goal-runtime.mjs');
const { createGoalRuntime, listStoredActiveGoalSessionIds, readStoredGoalSnapshot } = runtimeModule;
const { createGoalRecovery } = await importFrom(tree, 'src/standalone/session-service/session-calls/goal-recovery.mjs');
const { goalStateSnapshot, parseUserCommand } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/goal-state.mjs');
const text = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/goal-text.mjs');
const titles = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/session-title.mjs');

let seed = 0x6041a11;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const SESSIONS = ['s1', 's2', 'sess_3'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// The title model: a pure function of the objective.
const titleFor = async (objective) => {
  if (objective.includes('boom')) throw new Error('title model failed');
  if (objective.includes('notitle')) return '';
  if (objective.includes('same')) return objective;
  return `Title: ${objective.split(/\s+/).slice(0, 3).join(' ')}`;
};

const dirs = [];
function isolate() {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-goal-twin-'));
  dirs.push(dir);
  return dir;
}

function filesOf(dir) {
  const out = {};
  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith('.lock') && !/\.tmp/.test(entry.name)) {
        const name = relative(join(dir, 'goals'), full).split(sep).join('/').replace(/\.corrupt-\d+/, '.corrupt-<ts>');
        out[name] = readFileSync(full, 'utf8');
      }
    }
  };
  walk(join(dir, 'goals'));
  return out;
}

function makeRuntime(dir, options, errors) {
  const monotonic = options.monotonic ? () => mono : null;
  return createGoalRuntime({
    dataDir: dir,
    now: () => clock,
    monotonicNow: monotonic,
    ...(options.monotonic ? { suspendDetectable: true } : {}),
    defaultTimeLimitMs: options.defaultTimeLimitMs ?? 0,
    completedGoalTtlMs: options.completedGoalTtlMs,
    generateTitle: options.titles === false ? null : titleFor,
    onStorageError: (error) => errors.push(error?.message || String(error)),
  });
}

const goalRef = async (runtime, session, ref) => {
  if (ref === 'current') return (await runtime.storedSnapshot(session))?.id ?? '';
  if (ref === 'stale') return 'no-such-goal';
  return ref ?? undefined;
};
const resolveArgs = async (runtime, session, value) => {
  if (typeof value === 'string') return value.replace('$current', (await goalRef(runtime, session, 'current')) || 'none');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = key === 'expectedGoalId' && typeof entry === 'string' && entry.startsWith('$') ? await goalRef(runtime, session, entry.slice(1)) : entry;
    }
    return out;
  }
  return value;
};

async function settle(runtime, known) {
  for (let i = 0; i < 2; i += 1) {
    await sleep(2);
    for (const timer of [...fakeTimers.values()]) {
      if (timer.kind === 'cache') {
        fakeTimers.delete(timer.id);
        timer.fn();
      }
    }
    await sleep(8);
    for (const id of known) await runtime.clearLegacyTasks(id).catch(() => {});
  }
}

async function advance(runtime, known, ms) {
  const target = clock + ms;
  for (;;) {
    const due = [...fakeTimers.values()].filter((t) => t.kind !== 'cache' && t.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
    if (!due) break;
    const delta = Math.max(0, due.due - clock);
    clock += delta;
    mono += delta;
    if (due.interval) due.due += due.interval;
    else fakeTimers.delete(due.id);
    due.fn();
    await settle(runtime, known);
  }
  mono += target - clock;
  clock = target;
  await settle(runtime, known);
}

// Fires every timer due within `ms` without letting anything settle, then asks for a control:
// a timer's mutation is already queued when the control joins the session's queue.
async function fireThenControl(runtime, session, ms, request) {
  const target = clock + ms;
  for (;;) {
    const due = [...fakeTimers.values()].filter((t) => t.kind !== 'cache' && t.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
    if (!due) break;
    const delta = Math.max(0, due.due - clock);
    clock += delta;
    mono += delta;
    if (due.interval) due.due += due.interval;
    else fakeTimers.delete(due.id);
    due.fn();
  }
  mono += target - clock;
  clock = target;
  return runtime.control(session, await resolveArgs(runtime, session, request));
}

async function runOp(ctx, step) {
  const { runtime, dir } = ctx;
  const session = step.session ?? 's1';
  const args = step.args ?? {};
  switch (step.op) {
    case 'fireThenControl':
      return fireThenControl(runtime, session, args.ms, args.request);
    case 'control':
      return runtime.control(session, await resolveArgs(runtime, session, args.request));
    case 'tool':
      return runtime.executeTool('goal', await resolveArgs(runtime, session, args.input), { sessionId: session });
    case 'startTurn':
      return runtime.startTurn(session);
    case 'settleTurn':
      return runtime.settleTurn(session, args.detail);
    case 'continuation':
      return runtime.continuation(session, {
        agentStatus: args.awaiting ? { agentJobs: [{ status: 'running' }] } : null,
        todo: args.todo ?? '',
      });
    case 'reset':
      return runtime.resetContinuationRules(session);
    case 'archive':
      return runtime.archiveCompletedOnUserInput(session);
    case 'reactivate': {
      const goalId = await goalRef(runtime, session, args.goal);
      const log = [];
      const options = {};
      if (args.current !== undefined) options.isCurrent = () => (log.push('isCurrent'), args.current === 'throw' ? (() => { throw new Error('current failed'); })() : args.current);
      if (args.accept !== undefined) options.accept = () => (log.push('accept'), args.accept === 'throw' ? (() => { throw new Error('accept failed'); })() : args.accept);
      const goal = await runtime.reactivateUsageLimited(session, goalId, options);
      return { goal, called: log };
    }
    case 'snapshot':
      return runtime.snapshot(session);
    case 'stored':
      return runtime.storedSnapshot(session);
    case 'watch':
      return runtime.watchSession(session);
    case 'legacyTasks':
      return runtime.legacyTasks(session);
    case 'clearLegacy':
      return runtime.clearLegacyTasks(session);
    case 'stateSnapshot':
      return goalStateSnapshot(runtime.snapshot(session));
    case 'listStored':
      return listStoredActiveGoalSessionIds({ dataDir: dir, now: () => clock, completedGoalTtlMs: ctx.options.completedGoalTtlMs });
    case 'readStored':
      return readStoredGoalSnapshot({ dataDir: dir, sessionId: session, now: () => clock, completedGoalTtlMs: ctx.options.completedGoalTtlMs });
    case 'recover': {
      const lines = [];
      const stored = (id) => readStoredGoalSnapshot({ dataDir: dir, sessionId: id, now: () => clock });
      const recovery = createGoalRecovery({
        log: (line) => lines.push(line),
        readStoredGoal: stored,
        listStoredActiveGoalSessionIds: () => listStoredActiveGoalSessionIds({ dataDir: dir, now: () => clock }),
        materializeSession: async (id) => {
          if (id === 'sess_fail') throw new Error('cannot materialize');
          lines.push(`materialize ${id}`);
        },
      });
      return { summary: await recovery(), lines };
    }
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

// The ids Node mints are random: each distinct one is named by order of first appearance.
function namer() {
  const names = new Map();
  return (value) => JSON.parse(JSON.stringify(value ?? null).replace(UUID, (id) => {
    if (!names.has(id)) names.set(id, `<goal ${names.size + 1}>`);
    return names.get(id);
  }));
}

function scrub(dir) {
  const flat = dir.split(sep).join('/');
  return (value) => JSON.parse(JSON.stringify(value ?? null).split(JSON.stringify(dir).slice(1, -1)).join('<dir>').split(flat).join('<dir>'));
}

const cases = [];

async function record(name, { options = {}, files = {}, steps }) {
  const dir = isolate();
  clock = T0;
  mono = 5_000;
  fakeTimers.clear();
  mkdirSync(join(dir, 'goals'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const path = join(dir, 'goals', file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  const errors = [];
  let events = [];
  const ctx = { dir, options, errors };
  const start = () => {
    ctx.runtime = makeRuntime(dir, options, errors);
    ctx.unsubscribe = ctx.runtime.subscribe((event) => events.push(event));
  };
  start();
  const name1 = namer();
  const dirName = scrub(dir);
  const out = [];
  let previous = filesOf(dir);
  for (const step of steps) {
    if (process.env.GOAL_TRACE) console.error(name, step.op, JSON.stringify(step.args ?? {}).slice(0, 80));
    events = [];
    errors.length = 0;
    let result;
    try {
      if (step.op === 'advance') {
        await advance(ctx.runtime, SESSIONS, step.args.ms);
        result = { value: null };
      } else if (step.op === 'suspend') {
        clock += step.args.ms;
        result = { value: null };
      } else if (step.op === 'restart') {
        ctx.unsubscribe();
        await ctx.runtime.close();
        fakeTimers.clear();
        if (step.args?.ms) clock += step.args.ms;
        start();
        result = { value: null };
      } else {
        result = { value: plain(await runOp(ctx, step)) };
      }
    } catch (error) {
      result = { error: String(error?.message ?? error) };
    }
    if (step.op !== 'advance') await settle(ctx.runtime, SESSIONS);
    const live = [...fakeTimers.values()].filter((t) => t.kind === 'goal').map((t) => t.due - clock).sort((a, b) => a - b);
    const filesNow = filesOf(dir);
    const changed = JSON.stringify(filesNow) !== JSON.stringify(previous);
    previous = filesNow;
    const entry = { op: step.op, session: step.session ?? null, args: plain(step.args ?? {}), ...result, events: events.map((e) => plain(e)), timers: live, storageErrors: [...errors] };
    // Name ids in a fixed order (answer, events, files) so the Rust twin names them the same way.
    const named = {
      ...entry,
      ...(result.value !== undefined ? { value: name1(dirName(result.value)) } : { error: name1(dirName(result.error)) }),
      events: name1(entry.events),
      storageErrors: dirName(entry.storageErrors),
      ...(changed ? { files: name1(Object.fromEntries(Object.entries(filesNow).map(([k, v]) => [name1(k), v]))) } : {}),
    };
    out.push(named);
  }
  ctx.unsubscribe();
  await ctx.runtime.close();
  fakeTimers.clear();
  cases.push({ name, options, files: Object.fromEntries(Object.entries(files)), steps: out });
}

// ---- scripted sequences ------------------------------------------------------------------

const OBJECTIVES = ['Ship the release', 'Migrate the store to the new schema', 'same', 'boom now', 'notitle please', 'Refactor <module> & tests', '  padded objective  '];
const DETAILS = [
  { status: 'completed' },
  { status: 'completed', automatic: true, toolCalls: 0 },
  { status: 'completed', automatic: true, toolCalls: 3 },
  { status: 'cancelled' },
  { status: 'failed', error: 'provider exploded' },
  { status: 'failed' },
  { status: 'failed', usageLimited: true, error: 'quota used' },
  { status: 'completed', usageLimited: true },
  { status: 'completed', preserveGoalState: true },
  { status: 'completed', automatic: true, toolCalls: 0, preserveGoalState: true },
  'cancelled',
  'completed',
];
const CONTROLS = [
  '', 'status', 'pause', 'resume', 'resume 30m', 'resume 1d', 'resume 5s', 'resume banana', 'stop', 'clear', 'complete',
  'edit Better objective', 'edit', 'time 2h', 'time 10', 'time', 'time 8d', 'Ship it --time 30m', 'Ship it --time=2h', 'Ship it', 'Ship it --time=1m',
  'Another goal --replace', 'Another goal --replace=$current', 'Another goal --replace=nope', 'x --replace --time 1h', 'show', 'current',
  { action: 'dismiss' }, { action: 'get' }, { action: 'bogus' }, { action: 'clear' },
  { action: 'edit', objective: 'Edited by object', time_limit_minutes: 5 }, { action: 'edit', objective: 'Edited', time_limit_minutes: 0 },
  { action: 'edit', objective: 'Edited', time_limit_minutes: -1 }, { action: 'edit', objective: 'Edited', timeLimitMs: 0 }, { action: 'edit', objective: 'Edited', timeLimitMs: 120000 },
  { action: 'edit', objective: 'Edited', duration: '45m' }, { action: 'edit', objective: 'same objective' },
  { action: 'create', objective: 'Created by object', duration: '1h' }, { action: 'create', objective: 'Created', timeLimitMs: 90000 },
  { action: 'create', objective: '' }, { action: 'create', objective: 'Replace me', replace: true, expectedGoalId: '$current' },
  { action: 'resume', duration: '20m', expectedGoalId: '$stale' }, { action: 'pause', expectedGoalId: '$current' },
  { action: 'stop', expectedGoalId: '$stale' }, { action: 'time', duration: '90m' }, { action: 'complete', expectedGoalId: '$current' },
  { command: 'pause' }, { command: 'time 3h', action: 'get' },
];
const TOOLS = [
  { action: 'status' }, { action: 'Status' }, { action: 'create', objective: 'Tool goal', time_limit_minutes: 30 },
  { action: 'create', objective: 'Tool goal without cap' }, { action: 'create', objective: 'Tool boom goal', time_limit_minutes: 11 },
  { action: 'create' }, { action: 'create', objective: 'x', time_limit_minutes: 0.5 }, { action: 'create', objective: 'x', time_limit_minutes: 10081 },
  { action: 'create', objective: 'y'.repeat(4001) }, { action: 'complete' }, { action: 'block', blocker: 'Waiting on credentials' },
  { action: 'block' }, { action: 'block', blocker: 'z'.repeat(1001) }, { action: 'extend', extend_minutes: 15 }, { action: 'extend', extend_minutes: 10079 },
  { action: 'extend' }, { action: 'extend', extend_minutes: '5' }, { action: 'extend', extend_minutes: 0 }, { action: 'nope' }, {}, { action: 'status', stray: 1 },
  { action: 'create', objective: 'Legacy fields', tasks: [], revision: 1 }, { action: 'complete', time_limit_minutes: 5 },
];

function randomStep() {
  const session = chance(0.8) ? 's1' : pick(SESSIONS);
  const op = pick([
    'control', 'control', 'control', 'tool', 'tool', 'tool', 'startTurn', 'startTurn', 'settleTurn', 'settleTurn', 'continuation', 'continuation',
    'advance', 'advance', 'advance', 'snapshot', 'stored', 'watch', 'reset', 'archive', 'reactivate', 'suspend', 'restart', 'legacyTasks',
    'clearLegacy', 'stateSnapshot', 'listStored', 'readStored', 'recover',
  ]);
  switch (op) {
    case 'control':
      return { op, session, args: { request: pick(CONTROLS) } };
    case 'tool':
      return { op, session, args: { input: pick(TOOLS) } };
    case 'settleTurn':
      return { op, session, args: { detail: pick(DETAILS) } };
    case 'continuation':
      return { op, session, args: { awaiting: chance(0.15), todo: chance(0.4) ? 'Todo list for this Goal (exact wordings):\n- [ ] first <step>\n- [x] second & done' : '' } };
    case 'advance':
      return { op, args: { ms: pick([1_000, 59_000, 60_000, 61_000, 120_000, 300_000, 540_000, 600_000, 900_000, 1_800_000, 3_600_000, 90_000_000]) } };
    case 'suspend':
      return { op, args: { ms: pick([3_000, 10_000, 600_000]) } };
    case 'restart':
      return { op, args: { ms: pick([0, 0, 120_000, 4_000_000]) } };
    case 'reactivate':
      return { op, session, args: { goal: pick(['current', 'current', 'stale']), ...(chance(0.6) ? { current: pick([true, false, 'throw']) } : {}), ...(chance(0.6) ? { accept: pick([true, false, 'throw']) } : {}) } };
    default:
      return { op, session };
  }
}

function script(length, options) {
  const first = pick([
    { op: 'control', session: 's1', args: { request: pick(['Ship the release --time 30m', 'Ship the release', { action: 'create', objective: 'Created', duration: '12m' }]) } },
    { op: 'tool', session: 's1', args: { input: { action: 'create', objective: pick(OBJECTIVES), ...(options.cap ? { time_limit_minutes: pick([11, 30, 90]) } : {}) } } },
  ]);
  const steps = [first];
  for (let i = 1; i < length; i += 1) steps.push(randomStep());
  return steps;
}

for (let i = 0; i < 40; i += 1) {
  const options = { cap: chance(0.6), monotonic: chance(0.25), defaultTimeLimitMs: chance(0.2) ? 1_800_000 : 0, ...(chance(0.15) ? { titles: false } : {}) };
  const { cap, ...runtimeOptions } = options;
  await record(`script ${i}`, { options: runtimeOptions, steps: script(26, options) });
}

// A Goal with a cap walked through its warnings and its deadline.
await record('cap walk', {
  steps: [
    { op: 'tool', session: 's1', args: { input: { action: 'create', objective: 'Walk the cap', time_limit_minutes: 12 } } },
    { op: 'advance', args: { ms: 60_000 } }, { op: 'snapshot', session: 's1' }, { op: 'advance', args: { ms: 60_000 } },
    { op: 'advance', args: { ms: 300_000 } }, { op: 'continuation', session: 's1', args: {} }, { op: 'advance', args: { ms: 300_000 } },
    { op: 'snapshot', session: 's1' }, { op: 'tool', session: 's1', args: { input: { action: 'extend', extend_minutes: 30 } } },
    { op: 'advance', args: { ms: 1_800_000 } }, { op: 'advance', args: { ms: 600_000 } }, { op: 'settleTurn', session: 's1', args: { detail: { status: 'completed' } } },
    { op: 'continuation', session: 's1', args: {} }, { op: 'tool', session: 's1', args: { input: { action: 'extend', extend_minutes: 5 } } },
    { op: 'control', session: 's1', args: { request: 'resume' } },
  ],
});

// A deadline with exactly 10 s left is a goal timer like any other (the title timeout is 10 s too).
await record('deadline ten seconds left', {
  steps: [
    { op: 'tool', session: 's1', args: { input: { action: 'create', objective: 'Ten seconds', time_limit_minutes: 1 } } },
    { op: 'advance', args: { ms: 50_000 } }, { op: 'snapshot', session: 's1' }, { op: 'advance', args: { ms: 10_000 } }, { op: 'snapshot', session: 's1' },
  ],
});

// A warning fires and a pause is asked in the same turn: the warning publishes first.
await record('warning then pause', {
  steps: [
    { op: 'tool', session: 's1', args: { input: { action: 'create', objective: 'Warn then pause', time_limit_minutes: 12 } } },
    { op: 'fireThenControl', session: 's1', args: { ms: 121_000, request: 'pause' } }, { op: 'stored', session: 's1' },
  ],
});

// Suspend evidence: wall time that outran the monotonic clock is not the Goal's.
await record('suspend', {
  options: { monotonic: true },
  steps: [
    { op: 'control', session: 's1', args: { request: 'Ship it --time 30m' } }, { op: 'suspend', args: { ms: 600_000 } },
    { op: 'snapshot', session: 's1' }, { op: 'advance', args: { ms: 120_000 } }, { op: 'suspend', args: { ms: 3_000 } },
    { op: 'stored', session: 's1' }, { op: 'advance', args: { ms: 1_800_000 } }, { op: 'stored', session: 's1' },
  ],
});

// Recovery at boot: a Goal left active by the previous process, a long downtime, other states.
const goalFile = (goal) => `${JSON.stringify({ version: 1, goal }, null, 2)}\n`;
const record1 = (over) => ({
  id: 'g-1', sessionId: 's1', objective: 'Stored objective', title: 'Stored objective', objectiveRevision: 0, status: 'active', blocker: '',
  failureReason: '', failureCount: 0, turnCount: 2, timeLimitMs: 3_600_000, timeUsedMs: 120_000, deadlineWarnedMs: Number.MAX_SAFE_INTEGER, warningRevision: 0,
  createdAt: T0 - 7_200_000, updatedAt: T0 - 600_000, lastStartedAt: T0 - 600_000, liveAt: T0 - 540_000, completedAt: null, stoppedAt: null, archivedAt: null, ...over,
});
await record('recovery active after downtime', {
  files: { 's1.json': goalFile(record1({})), 's2.json': goalFile(record1({ id: 'g-2', sessionId: 's2', status: 'paused', lastStartedAt: null })), 'sess_fail.json': goalFile(record1({ id: 'g-f', sessionId: 'sess_fail' })) },
  steps: [
    { op: 'listStored' }, { op: 'readStored', session: 's1' }, { op: 'recover' }, { op: 'snapshot', session: 's1' }, { op: 'advance', args: { ms: 60_000 } },
    { op: 'stored', session: 's2' }, { op: 'restart', args: { ms: 900_000 } }, { op: 'snapshot', session: 's1' }, { op: 'continuation', session: 's1', args: {} },
  ],
});
await record('recovery completed ttl', {
  options: { completedGoalTtlMs: 3_600_000 },
  files: {
    's1.json': goalFile(record1({ status: 'complete', completedAt: T0 - 7_200_000, lastStartedAt: null })),
    's2.json': goalFile(record1({ id: 'g-2', sessionId: 's2', status: 'complete', completedAt: T0 - 60_000, lastStartedAt: null })),
    'sess_3.json': goalFile(record1({ id: 'g-3', sessionId: 'sess_3', archivedAt: T0 - 10 })),
  },
  steps: [{ op: 'listStored' }, { op: 'readStored', session: 's1' }, { op: 'readStored', session: 's2' }, { op: 'stored', session: 's2' }, { op: 'stored', session: 's1' }, { op: 'snapshot', session: 'sess_3' }, { op: 'stored', session: 'sess_3' }, { op: 'listStored' }, { op: 'recover' }],
});
const damaged = [
  ['empty', ''], ['torn', '{"version":1,"goal":{'], ['not an object', '[1]'], ['bom', `\ufeff${goalFile(record1({}))}`],
  ['version zero', JSON.stringify({ version: 0, goal: null })], ['no goal key', JSON.stringify({ version: 1 })], ['goal array', JSON.stringify({ version: 1, goal: [] })],
  ['goal string', JSON.stringify({ version: 1, goal: 'x' })], ['newer', JSON.stringify({ version: 2, goal: record1({}), extra: true })],
  ['bad status', goalFile(record1({ status: 'mystery' }))], ['no objective', goalFile(record1({ objective: '  ' }))],
  ['budget limited', goalFile(record1({ status: 'budget_limited', timeUsedMs: 9_999_999 }))],
  ['legacy tasks', goalFile({ ...record1({}), legacyTasks: undefined, tasks: [{ text: 'a' }, { content: 'b', status: 'done' }, { text: ' ', satisfied: true }, { text: 'c', satisfied: true }, null, 4] })],
  ['legacy criteria', goalFile({ ...record1({}), criteria: [{ text: 'k', satisfied: true }] })],
  ['odd numbers', goalFile(record1({ turnCount: -3, failureCount: 2.7, timeLimitMs: 5, timeUsedMs: 'x', warningRevision: '4', deadlineWarnedMs: -2, objectiveRevision: 2.9, pauseReason: 'waiting' }))],
  ['over cap', goalFile(record1({ timeLimitMs: 99_999_999_999 }))],
];
for (const [label, content] of damaged) {
  await record(`stored ${label}`, {
    files: { 's1.json': content, ...(label === 'bad status' || label === 'no objective' ? { 's1.json.bak': goalFile(record1({ objective: 'From backup' })) } : {}) },
    steps: [
      { op: 'readStored', session: 's1' }, { op: 'listStored' }, { op: 'snapshot', session: 's1' }, { op: 'legacyTasks', session: 's1' },
      { op: 'control', session: 's1', args: { request: 'pause' } }, { op: 'tool', session: 's1', args: { input: { action: 'create', objective: 'After damage' } } },
      { op: 'clearLegacy', session: 's1' }, { op: 'restart', args: { ms: 0 } }, { op: 'stored', session: 's1' },
    ],
  });
}
// An invalid session id, and a replaced Goal moving to history.
await record('session ids', {
  steps: [
    { op: 'snapshot', session: 'bad id' }, { op: 'control', session: '../x', args: { request: 'status' } }, { op: 'tool', session: '', args: { input: { action: 'status' } } },
    { op: 'startTurn', session: 'a b' }, { op: 'archive', session: '' }, { op: 'watch', session: '' }, { op: 'watch', session: 's1' },
    { op: 'control', session: 's1', args: { request: 'one' } }, { op: 'control', session: 's1', args: { request: 'two' } },
    { op: 'control', session: 's1', args: { request: 'pause' } }, { op: 'control', session: 's1', args: { request: 'three --replace' } },
    { op: 'control', session: 's1', args: { request: 'three --replace=$current' } }, { op: 'control', session: 's1', args: { request: 'complete' } },
    { op: 'control', session: 's1', args: { request: 'four' } }, { op: 'archive', session: 's1' },
  ],
});

// The pure texts and parsers the runtime builds on.
const sampleGoals = [
  { objective: 'Ship <it> & done', status: 'active', timeLimitMs: 3_600_000, timeUsedMs: 61_000 },
  { objective: 'No cap', status: 'active', timeLimitMs: 0, timeUsedMs: 0 },
  { objective: 'Waiting', status: 'paused', pauseReason: 'cancelled', timeLimitMs: 120_000, timeUsedMs: 1 },
  { objective: 'Waiting', status: 'paused', pauseReason: 'waiting', timeLimitMs: 0, timeUsedMs: 90_000_000 },
  { objective: 'Waiting', status: 'paused', timeLimitMs: 0, timeUsedMs: 5 },
  { objective: 'Blocked', status: 'blocked', blocker: 'needs <creds>', timeLimitMs: 0, timeUsedMs: 5 },
  { objective: 'Done', status: 'duration_reached', timeLimitMs: 60_000, timeUsedMs: 60_000 },
  { objective: 'Limit', status: 'usage_limited', blocker: 'quota', timeLimitMs: 0, timeUsedMs: 5 },
];
const reminders = [];
for (const goal of sampleGoals) {
  for (const reason of ['', 'compaction', 'objective-updated', 'deadline-soon', 'deadline-reached']) {
    reminders.push({ goal, reason, text: text.goalStateReminder(goal, { reason }) });
  }
}
const prompts = [];
for (const goal of sampleGoals) {
  for (const includeRules of [true, false]) {
    for (const todo of ['', 'Todo list:\n- a']) prompts.push({ goal, includeRules, todo, text: text.continuationPrompt(goal, { includeRules, todo }) });
  }
}
const labels = [0, 1, 59_999, 60_000, 60_001, 3_600_000, 86_400_000, 90_061_000, 1e12, -5, null, 'x'].map((ms) => ({ ms: plain(ms), label: text.durationLabel(ms) }));
const commands = ['', '  ', 'status', 'show', 'current', 'pause', 'STOP', 'clear', 'complete', 'resume', 'resume 1h', 'edit', 'edit  a b ', 'time', 'time 2h', 'x', 'x --time 30m', 'x --time=30m', 'x --TIME 1h',
  'x --time=1h --time 2h', 'x --replace', 'x --replace=abc', 'x --replace= y', 'x --REPLACE=a1 --time=5m', 'x --replacefoo --replace', '--time 10m only', 'a --time', 'a --time   '].map((command) => ({ command, parsed: parseUserCommand(command) }));
const titleCases = ['', '  ', 'Hello world', '"Quoted title".', '# Heading', '<think>x</think> Real title', '<THINK>\nx\n</THINK>\nSecond line', '\n\nfirst\nsecond', 'A very long title that keeps going well past the limit of thirty two',
  'Averyveryveryverylongwordwithnospacesatallinthistitleexceeds', '日本語のタイトルがとても長くなる場合はどうなるのでしょうか、切り詰めます', '👨‍👩‍👧‍👦 family emoji title that is quite long indeed yes', '!!!', '123', '   x   ', 'ends with dots...', 'tab\there'].map((value) => ({ value, title: titles.compactSessionTitle(value) }));

const durations = [];
const stateModule = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/goal-state.mjs');
for (const value of ['30m', '2h', '1h30m', ' 1H 30M ', '90s', '1d', '7d', '8d', '0.5h', '59s', '1.5m', '', '  ', 'abc', '5', '30', '1h-30m', 'x1h', '1hx', '1h 1h', 60_000, 59_999, 0, -1, 1.4, 604_800_000, 604_800_001, null, undefined, true, '10m5s']) {
  let result;
  try {
    result = { value: stateModule.parseGoalDuration(value) };
  } catch (error) {
    result = { error: error.message };
  }
  durations.push({ input: value === undefined ? { undefined: true } : value, ...result });
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'goal');
writeJson(join(outDir, 'goal-runtime-twin.json'), {
  domain: 'goal-runtime-twin',
  recorder: 'benchmarks/rust-core/recorders/record-goal-runtime.mjs',
  start: T0,
  cases,
  reminders,
  prompts,
  durationLabels: labels,
  commands,
  titles: titleCases,
  durations,
});
writeSetManifest(outDir, {
  set: 'goal',
  recorder: 'benchmarks/rust-core/recorders/record-goal-runtime.mjs',
  command: 'node benchmarks/rust-core/recorders/record-goal-runtime.mjs --tree <tree>',
  identityTree: tree,
});
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
const ops = cases.flatMap((c) => c.steps);
console.log(`recorded ${cases.length} cases, ${ops.length} operations (${ops.filter((o) => o.error).length} errors)`);
process.exit(0);
