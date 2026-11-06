#!/usr/bin/env node
// Golden twin of the daemon's quota auto-resume clock (standalone/session-service/quota-resume.mjs):
// Node's real createQuotaResumeScheduler runs over Node's real quota-resume store, with a scripted
// clock, timer, session and usage reading. Each case records the delay the one timer is armed
// for, then per tick the log lines, the queue left behind and the re-armed delay. Rust
// `mixdog_core_session::session::quota_resume_scheduler` must equal it.
//
//   node benchmarks/rust-core/recorders/record-quota-scheduler.mjs --tree <dir>
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const dir = mkdtempSync(join(tmpdir(), 'mixdog-quota-scheduler-twin-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_CONFIG_DIR = dir;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const store = await importFrom(tree, 'src/runtime/shared/quota-resume-store.mjs');
const config = await importFrom(tree, 'src/runtime/shared/config.mjs');
const { QUOTA_RESUME_FILE } = store;
const { createQuotaResumeScheduler } = await importFrom(tree, 'src/standalone/session-service/quota-resume.mjs');

const NOW = 1_000_000;
const A = { provider: 'openai-oauth', model: 'gpt-x' };
const B = { provider: 'anthropic', model: 'claude-y' };
const entry = (sessionId, resetIn, extra = {}) => ({
  sessionId,
  turnKey: `turn:${sessionId}`,
  provider: A.provider,
  model: A.model,
  resetIn,
  ...extra,
});

// materialize: null | error text; routes: what the session reports on each read (the last repeats);
// usable: true | false | { fail } | { proxy }; fire: outcome name | { fail }; steps: clock advances.
const CASES = [
  { name: 'empty queue', entries: [], steps: [] },
  { name: 'future entry waits then fires', entries: [entry('s1', 5000)], steps: [{ advance: 0 }, { advance: 5000 }] },
  { name: 'timer is capped', entries: [entry('s1', 3_000_000_000)], steps: [] },
  { name: 'overdue entry', entries: [entry('s1', -10)], steps: [{ advance: 0 }] },
  { name: 'earliest of two', entries: [entry('s1', 9000), entry('s2', 4000)], steps: [{ advance: 4000 }, { advance: 5000 }] },
  { name: 'exhausted retries once', entries: [entry('s1', 0)], usable: false, steps: [{ advance: 0 }, { advance: 300000 }] },
  { name: 'busy rechecks without an attempt', entries: [entry('s1', 0)], fire: 'busy', steps: [{ advance: 0 }, { advance: 30000 }] },
  { name: 'rejected rechecks', entries: [entry('s1', 0)], fire: 'rejected', steps: [{ advance: 0 }] },
  { name: 'stale settles', entries: [entry('s1', 0)], fire: 'stale', steps: [{ advance: 0 }] },
  { name: 'superseded settles', entries: [entry('s1', 0)], fire: 'superseded', steps: [{ advance: 0 }] },
  { name: 'unreplayable settles', entries: [entry('s1', 0)], fire: 'unreplayable', steps: [{ advance: 0 }] },
  { name: 'fire throws', entries: [entry('s1', 0)], fire: { fail: 'lane gone' }, steps: [{ advance: 0 }] },
  { name: 'session cannot load', entries: [entry('s1', 0)], materialize: 'no such session', steps: [{ advance: 0 }] },
  { name: 'usage reading fails', entries: [entry('s1', 0)], usable: { fail: 'timeout' }, steps: [{ advance: 0 }] },
  { name: 'pc disconnected', entries: [entry('s1', 0)], usable: { proxy: 'pc offline' }, steps: [{ advance: 0 }] },
  { name: 'route changes under the reading', entries: [entry('s1', 0)], routes: [A, B], steps: [{ advance: 0 }] },
  { name: 'session route unknown uses the entry', entries: [entry('s1', 0)], routes: [{ provider: '', model: '' }], steps: [{ advance: 0 }] },
  { name: 'session on another route', entries: [entry('s1', 0)], routes: [B], steps: [{ advance: 0 }] },
  { name: 'setting off cancels all', entries: [entry('s1', 0), entry('s2', 100)], autoResume: false, steps: [{ advance: 0 }] },
  { name: 'two due in one pass', entries: [entry('s1', 0), entry('s2', 0)], steps: [{ advance: 0 }] },
];

// Cases driven by the timer's own wakeup (the task handed to setTimer), not by a hand `tick()`.
// A step is { advance } (the clock moves, the armed timer fires) or { restart } (the daemon stops
// and starts again over the same store file). `storeFile` is the file Node's store wrote.
const TIMER_CASES = [
  { name: 'timer fires the due entry', entries: [entry('s1', 5000)], timerSteps: [{ advance: 5000 }] },
  { name: 'timer walks two entries', entries: [entry('s1', 9000), entry('s2', 4000)], timerSteps: [{ advance: 4000 }, { advance: 5000 }] },
  { name: 'timer retries an exhausted reading once', entries: [entry('s1', 0)], usable: false, timerSteps: [{ advance: 0 }, { advance: 300000 }] },
  { name: 'timer rechecks a busy session', entries: [entry('s1', 0)], fire: 'busy', timerSteps: [{ advance: 0 }, { advance: 30000 }] },
  {
    name: 'pending resumes survive a restart and fire once',
    entries: [entry('s1', -10), entry('s2', 5000)],
    timerSteps: [{ restart: true }, { advance: 0 }, { restart: true }, { advance: 5000 }],
  },
];

const idle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolveTurn) => setImmediate(resolveTurn));
};

function runCase(spec) {
  store.reloadQuotaResumeStore();
  store.cancelAllQuotaResumeEntries();
  config.updateSection('quotaResume', () => ({ autoResume: spec.autoResume !== false }));
  let clock = NOW;
  let timer = null;
  const log = [];
  const reads = {};
  const fireCalls = [];
  const usableCalls = [];
  const build = () => createQuotaResumeScheduler({
    store,
    materializeSession: async (id) => {
      if (spec.materialize) throw new Error(spec.materialize);
      const routes = spec.routes ?? [A];
      return {
        getState: () => {
          reads[id] = (reads[id] ?? 0) + 1;
          return routes[Math.min(reads[id], routes.length) - 1];
        },
        fireQuotaResume: async ({ generation }) => {
          const fire = spec.fire ?? 'fired';
          fireCalls.push({ sessionId: id, generation: generation - base });
          if (typeof fire === 'object') throw new Error(fire.fail);
          return fire;
        },
      };
    },
    readQuotaUsable: async (provider, model) => {
      usableCalls.push({ provider, model });
      const usable = spec.usable ?? true;
      if (usable?.fail) throw new Error(usable.fail);
      if (usable?.proxy) throw Object.assign(new Error(usable.proxy), { code: 'MODEL_PROXY_UNAVAILABLE' });
      return usable;
    },
    log: (line) => log.push(line),
    now: () => clock,
    setTimer: (task, ms) => (timer = { ms, task }),
    clearTimer: () => (timer = null),
  });
  let scheduler = build();
  for (const e of spec.entries) {
    const { resetIn, ...args } = e;
    store.scheduleQuotaResumeEntry({ ...args, resetAt: NOW + resetIn });
  }
  let base = 0;
  const queue = () =>
    store.listQuotaResumeEntries().map((e) => ({
      sessionId: e.sessionId,
      generation: e.generation - base,
      resetAt: e.resetAt - NOW,
      attempts: e.attempts,
    }));
  base = Math.min(...store.listQuotaResumeEntries().map((e) => e.generation), Infinity) - 1;
  const storeFile = spec.entries.length ? readFileSync(join(dir, QUOTA_RESUME_FILE), 'utf8') : null;
  scheduler.start();
  const out = { name: spec.name, entries: store.listQuotaResumeEntries().map((e) => ({ ...e, generation: e.generation - base, resetAt: e.resetAt - NOW })), armed: timer?.ms ?? null, base, storeFile, steps: [] };
  const timerStep = async (advance) => {
    clock += advance;
    log.length = 0;
    fireCalls.length = 0;
    usableCalls.length = 0;
    const { ms: wait, task } = timer;
    timer = null;
    task();
    await idle();
    return { advance, wait, log: [...log], usable: [...usableCalls], fire: [...fireCalls], queue: queue(), armed: timer?.ms ?? null };
  };
  const restart = () => {
    scheduler.stop();
    store.reloadQuotaResumeStore();
    scheduler = build();
    scheduler.start();
    return { restart: true, queue: queue(), armed: timer?.ms ?? null };
  };
  return { out, stop: () => scheduler.stop(), timerStep, restart, step: async (advance) => {
    clock += advance;
    log.length = 0;
    fireCalls.length = 0;
    usableCalls.length = 0;
    await scheduler.tick();
    return { advance, log: [...log], usable: [...usableCalls], fire: [...fireCalls], queue: queue(), armed: timer?.ms ?? null };
  } };
}

const cases = [];
for (const spec of CASES) {
  const { out, stop, step } = runCase(spec);
  for (const s of spec.steps) out.steps.push(await step(s.advance));
  stop();
  cases.push({ ...spec, ...out, entries: spec.entries, scheduled: out.entries, steps: out.steps });
}

const timerCases = [];
for (const spec of TIMER_CASES) {
  const { out, stop, timerStep, restart } = runCase(spec);
  for (const s of spec.timerSteps) out.steps.push(s.restart ? restart() : await timerStep(s.advance));
  stop();
  timerCases.push({ ...spec, ...out, entries: spec.entries, scheduled: out.entries, steps: out.steps });
}

// Two overlapping ticks while a fire is in flight: Node's `tick()` answers the pass already
// running (the same promise), so the entry fires once.
async function coalesceProbe() {
  store.reloadQuotaResumeStore();
  store.cancelAllQuotaResumeEntries();
  config.updateSection('quotaResume', () => ({ autoResume: true }));
  store.scheduleQuotaResumeEntry({ sessionId: 's1', turnKey: 'turn:s1', provider: A.provider, model: A.model, resetAt: NOW });
  const base = store.listQuotaResumeEntries()[0].generation - 1;
  let release;
  const gate = new Promise((open) => (release = open));
  const fires = [];
  const scheduler = createQuotaResumeScheduler({
    store,
    materializeSession: async () => ({
      getState: () => A,
      fireQuotaResume: async ({ generation }) => {
        fires.push(generation - base);
        await gate;
        return 'fired';
      },
    }),
    readQuotaUsable: async () => true,
    log: () => {},
    now: () => NOW,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  const first = scheduler.tick();
  await idle();
  const second = scheduler.tick();
  const samePromise = first === second;
  await idle();
  const firesWhileHeld = fires.length;
  release();
  await Promise.all([first, second]);
  return { samePromise, firesWhileHeld, fires, queue: store.listQuotaResumeEntries().length };
}
const coalesce = await coalesceProbe();

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'quota-scheduler');
writeJson(join(outDir, 'golden.json'), {
  domain: 'quota-scheduler',
  recorder: 'benchmarks/rust-core/recorders/record-quota-scheduler.mjs',
  now: NOW,
  cases,
  timerCases,
  coalesce,
});
writeSetManifest(outDir, {
  set: 'quota-scheduler',
  recorder: 'benchmarks/rust-core/recorders/record-quota-scheduler.mjs',
  command: 'node benchmarks/rust-core/recorders/record-quota-scheduler.mjs --tree <tree>',
  identityTree: tree,
});
rmSync(dir, { recursive: true, force: true });
console.log(`recorded ${cases.length} cases, ${cases.reduce((n, c) => n + c.steps.length, 0)} ticks`);