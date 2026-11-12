#!/usr/bin/env node
// Recording of Node's scheduler (b6f10295a src/runtime/channels/lib/scheduler.mjs) around a rename of a schedule: after each
// of the outcomes a user can get from a rename (the new name taken, a run of the schedule in flight, the row moved and the reload
// failing, the rename applied and its answer lost), what fires next and when. The real Scheduler runs with its real timers and
// node-cron on a virtual clock (node:test mock.timers: setTimeout, setInterval and Date), moved only by the advances each case
// lists. Only the PostgreSQL row store (schedules-db.mjs) is an in-memory table that follows its SQL, as Node's scheduler tests
// replace it; the rename is the worker's `renameLocked(name, () => renameSchedule(...), { newName, reload })`
// (worker-main.mjs:229-233), its reload `reloadConfig(listSchedules())`.
//
//   node --experimental-test-module-mocks benchmarks/rust-core/recorders/record-schedule-rename-timers-cases.mjs \
//        --tree <export of b6f10295a with node_modules>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { exact } from './lib/exact.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SET = 'schedule-rename-timers-cases';
const tree = resolveTree(parseArgs());
await importFrom(tree, 'scripts/lib/isolated-test-env.mjs');
// The scheduler's lock (`scheduler.lock` in the runtime root) of a root of this run only, not a running Mixdog's.
const runtimeRoot = mkdtempSync(join(tmpdir(), 'schedule-rename-timers-'));
process.env.MIXDOG_RUNTIME_ROOT = runtimeRoot;

// The row store: one table, read and written as schedules-db.mjs's statements do (a read is a new object every time).
const table = new Map();
const copy = (row) => (row ? structuredClone(row) : null);
const iso = (date) => (date == null ? null : new Date(date).toISOString());
const update = (name, change) => {
  const row = table.get(name);
  if (!row) return null;
  change(row);
  return copy(row);
};
const dbUrl = pathToFileURL(join(tree, 'src/runtime/channels/lib/schedules-db.mjs')).href;
const realDb = await import(dbUrl);
const { scheduleNameTakenError } = await importFrom(tree, 'src/runtime/channels/lib/schedule-errors.mjs');
const activeSlot = (row, scheduledAt) =>
  row && row.status === 'active' && row.enabled !== false && (row.lastScheduledAt == null || Date.parse(row.lastScheduledAt) < scheduledAt.getTime());
mock.module(dbUrl, {
  namedExports: {
    ...realDb,
    listSchedules: async () => [...table.keys()].sort().map((name) => copy(table.get(name))),
    getSchedule: async (name) => copy(table.get(name)),
    renameSchedule: async (oldName, def) => {
      if (!table.has(oldName)) return null;
      if (def.name !== oldName && table.has(def.name)) throw scheduleNameTakenError(def.name);
      const row = { ...table.get(oldName), ...def };
      table.delete(oldName);
      table.set(def.name, row);
      return copy(row);
    },
    markFired: async (name, ts = new Date()) => update(name, (row) => (row.lastFiredAt = iso(ts))),
    setNextFire: async (name, ts) => update(name, (row) => (row.nextFireAt = iso(ts))),
    advanceScheduleCursor: async (name, scheduledAt, nextFireAt) =>
      activeSlot(table.get(name), scheduledAt) ? update(name, (row) => Object.assign(row, { lastScheduledAt: iso(scheduledAt), nextFireAt: iso(nextFireAt) })) : null,
    claimScheduleRun: async (name, scheduledAt, startedAt, nextFireAt) =>
      activeSlot(table.get(name), scheduledAt)
        ? update(name, (row) => Object.assign(row, { lastScheduledAt: iso(scheduledAt), lastStartedAt: iso(startedAt), lastFiredAt: iso(startedAt), nextFireAt: iso(nextFireAt) }))
        : null,
    markScheduleSuccess: async (name, ts = new Date()) => update(name, (row) => Object.assign(row, { lastSuccessAt: iso(ts), consecutiveFailures: 0 })),
    markScheduleFailure: async (name, ts = new Date()) => update(name, (row) => Object.assign(row, { lastFailedAt: iso(ts), consecutiveFailures: (row.consecutiveFailures ?? 0) + 1 })),
    markScheduleSkipped: async (name, ts = new Date()) => update(name, (row) => (row.lastSkippedAt = iso(ts))),
    markDone: async (name) => update(name, (row) => Object.assign(row, { status: 'done', nextFireAt: null })),
    setDeferred: async (name, ts) => update(name, (row) => (row.deferredUntil = iso(ts))),
    setSkippedUntil: async (name, ts) => update(name, (row) => (row.skippedUntil = iso(ts))),
  },
});
const { Scheduler } = await importFrom(tree, 'src/runtime/channels/lib/scheduler.mjs');
const { listSchedules, renameSchedule } = await import(dbUrl);

const START = '2025-01-01T08:00:00.000Z';
const OTHER = { name: 'other', prompt: 'once', whenAt: '2025-01-01T08:00:10.000Z', enabled: true, status: 'active', ownerAgentId: 'lead' };
const KEEP = { name: 'keep', prompt: 'do it', whenCron: '0 9 * * *', timezone: 'UTC', enabled: true, status: 'active', ownerAgentId: 'lead' };
const TAKEN = { name: 'renamed', prompt: 'later', whenAt: '2025-02-01T08:00:00.000Z', enabled: true, status: 'active', ownerAgentId: 'lead' };
/** The renamed definition the rename writes (the Schedules view's edit keeps the timing). */
const RENAMED = { ...OTHER, name: 'renamed' };

/** Lets the scheduler's promise chains run (the store and the runner answer at once); a condition never met is the recorder's failure. */
async function until(done, what) {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (done()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`recorder: ${what} never happened`);
}
/** The promise chains a tick started, run to their end: the store and the runner answer at once, so 200 turns of the
 *  event loop outlast every chain (checked: the result is the same with 2000). */
async function settle() {
  for (let turn = 0; turn < 200; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}
const advanceTo = (instant) => mock.timers.tick(Date.parse(instant) - Date.now());
const errorOf = (error) => (error ? { code: error.code ?? null, message: error.message, details: error.details ?? null } : null);

async function scenario(outcome) {
  table.clear();
  for (const row of outcome === 'nameTaken' ? [OTHER, KEEP, TAKEN] : [OTHER, KEEP]) table.set(row.name, copy(row));
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(START) });
  const runs = [];
  let release = null;
  const held = outcome === 'running' ? new Promise((resolve) => (release = resolve)) : null;
  const scheduler = new Scheduler([OTHER, KEEP].map(copy));
  scheduler.setScheduleRunner(async (schedule) => {
    runs.push({ name: schedule.name, at: new Date().toISOString() });
    if (held) await held;
    return { sessionId: 'sess', result: '' };
  });
  const steps = [];
  try {
    scheduler.start();
    // The clock is moved to each instant a timer is due, so a fire runs at its own instant as it would in real time.
    const due = '2025-01-01T08:00:10.000Z';
    const renameTakesUntil = '2025-01-01T08:00:15.000Z';
    if (outcome === 'running') {
      advanceTo(due);
      steps.push({ advanceTo: due });
      await until(() => runs.length === 1, 'the one-shot to start its run');
    }
    let renameRan = false;
    const refusal = await scheduler
      .renameLocked(
        'other',
        async () => {
          renameRan = true;
          // The row update takes until 08:00:15: the one-shot's timer (08:00:10) comes due meanwhile and is refused.
          advanceTo(due);
          await until(() => scheduler.renameBlocked?.has('other'), 'the one-shot due during the rename to be refused');
          advanceTo(renameTakesUntil);
          const moved = await renameSchedule('other', RENAMED);
          // The row moved and the answer was lost (the worker's call timing out, channel-config-api.mjs:63): the scheduler
          // sees a failed rename, the table has the new name.
          if (outcome === 'applied') throw new Error('timeout');
          return moved;
        },
        {
          newName: 'renamed',
          reload: async () => {
            if (outcome === 'reloadFailed') throw new Error('timeout');
            scheduler.reloadConfig(await listSchedules());
          },
        }
      )
      .then(
        () => null,
        (error) => error
      );
    if (renameRan) steps.push({ renameAdvancesTo: [due, renameTakesUntil] });
    const armed = () => [...new Set([...scheduler.cronJobs.keys(), ...scheduler.oneShotTimers.keys()])].sort();
    const refused = { at: new Date().toISOString(), error: errorOf(refusal), renameRan, status: scheduler.getStatus(), armed: armed() };
    if (outcome === 'applied') {
      // What the client does after an unanswered rename (channel-config-api.mjs:61 reloadChannelsSoon): the worker re-reads the table.
      await scheduler.reloadConfig(await listSchedules());
      await settle();
      steps.push({ reloadedFromStore: true, status: scheduler.getStatus(), armed: armed() });
    }
    if (release) {
      release();
      await until(() => table.get('other')?.status === 'done', 'the held run to finish');
    }
    for (const instant of [renameTakesUntil, '2025-01-01T09:00:00.000Z']) {
      const before = runs.length;
      advanceTo(instant);
      steps.push({ advanceTo: instant });
      // Every fire due by now has reached the runner (node-cron hands its fire on through promises) and every run has finished.
      await settle();
      await until(() => scheduler.running.size === 0, `the runs due by ${instant} to finish`);
      steps.push({ ranBy: instant, runs: runs.slice(before) });
    }
    return { outcome, start: START, loaded: [OTHER, KEEP], stored: outcome === 'nameTaken' ? [OTHER, KEEP, TAKEN] : [OTHER, KEEP], renamedTo: RENAMED, steps, refused, runs, statusAtEnd: scheduler.getStatus(), armedAtEnd: armed() };
  } finally {
    scheduler.stop();
    mock.timers.reset();
  }
}

const OUTCOMES = [
  ['the new name is taken (SCHEDULE_NAME_TAKEN)', 'nameTaken'],
  ['a run of the schedule is in flight (SCHEDULE_RENAME_RUNNING)', 'running'],
  ['the row moved and the reload failed (SCHEDULE_RENAME_RELOAD_FAILED)', 'reloadFailed'],
  ['the row moved and the answer was lost, then the worker re-read the table (SCHEDULE_RENAME_UNCERTAIN in Node, opOutcomeUnknown in K1)', 'applied'],
];
const cases = [];
for (const [name, outcome] of OUTCOMES) cases.push({ case: `after a rename: ${name}`, observed: exact(await scenario(outcome), { path: name }) });

const finalDir = join(FIXTURES_ROOT, SET);
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { cases });
const provenance = recorderProvenance(import.meta.url);
writeSetManifest(stage, {
  set: SET,
  recorder: provenance.recorder,
  command: `node ${process.execArgv.join(' ')} ${provenance.recorder} --tree <export of ${COMMIT} with node_modules>`,
  identity: exactProductIdentity(tree, COMMIT),
  extra: {
    ...provenance,
    cases: cases.length,
    values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
    entry: {
      runs: 'src/runtime/channels/lib/scheduler.mjs Scheduler: start, renameLocked with the worker\'s rename and reload, the one-shot timers and node-cron, getStatus; the scheduler\'s runner records each run with the clock',
      notRun: 'PostgreSQL: schedules-db.mjs is an in-memory table following its statements (renameSchedule refuses a taken name with scheduleNameTakenError, as its 23505 handler does)',
      clock: 'node:test mock.timers (setTimeout, setInterval, Date) from start; moved only by the steps listed in each case',
    },
    replay: {
      entry: 'mixdog-services/src/scheduler/engine.rs Scheduler: start, rename_locked with the store\'s rename and the runtime\'s reload (reload_config of the stored rows), the one-shot and cron timers on tokio\'s paused clock, status; the runner records each run with the clock. Replayed by mixdog-services/src/scheduler/rename_timers_replay_tests.rs.',
      compare: 'per case, whole: the refusal (code, message, details), whether the rename ran, the status and the armed timers (names with a cron job or a one-shot timer) after the refusal, after the reload from the table (applied case) and at the end, each run with its instant, in order',
    },
    exclusions: {},
  },
});
commitStage(stage, finalDir);
rmSync(runtimeRoot, { recursive: true, force: true });
console.log(`${SET}: ${cases.length} cases`);
process.exit(0);
