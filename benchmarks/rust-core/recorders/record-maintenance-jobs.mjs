#!/usr/bin/env node
// Golden twin of the daemon's two periodic jobs the session runtime now owns:
//  - the idle-time schedule that drives the worktree cleanup (`shared/maintenance-schedule.mjs`,
//    registered by `standalone/daemon.mjs`: first run 3 minutes after registering, then hourly)
//    and the cleanup's pure selection (`shared/worktrees/maintenance.mjs` selectWorktreeCleanup);
//  - the attachment garbage collection census (`attachments/store.mjs` collectPromptAttachments)
//    over a real data directory, and the spacing/delay constants of its trigger.
// Rust `mixdog-core-base` `maintenance` and `blob_gc`, `mixdog-scm` `worktree::maintenance` and
// `mixdog-core-session` `worktree_maintenance` must equal it.
//
//   node benchmarks/rust-core/recorders/record-maintenance-jobs.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const recorder = 'benchmarks/rust-core/recorders/record-maintenance-jobs.mjs';

// ---- the schedule -------------------------------------------------------------------------
const schedule = await importFrom(tree, 'src/runtime/shared/maintenance-schedule.mjs');
const STATE_KEY = Symbol.for('mixdog.maintenanceSchedule.v1');
const MIN = 60_000;
const T0 = 1_000_000_000_000;
const daemonSource = readFileSync(join(tree, 'src/standalone/daemon.mjs'), 'utf8');
const cleanupOptions = /'worktree-cleanup',[\s\S]*?intervalMs: ([\d* _]+),\s*initialDelayMs: ([\d* _]+),/.exec(daemonSource);
const evalMs = (text) => text.replaceAll('_', '').split('*').reduce((product, part) => product * Number(part), 1);
const constants = { cleanupIntervalMs: evalMs(cleanupOptions[1]), cleanupInitialDelayMs: evalMs(cleanupOptions[2]) };

/** Registers `tasks` ([name, intervalMs, initialDelayMs, fails]) at T0, then runs `ticks` ([offsetMs, idle]). */
async function timeline(tasks, ticks) {
  delete globalThis[STATE_KEY];
  const runs = [];
  const errors = [];
  let idle = true;
  schedule.registerMaintenanceIdleProbe(() => idle);
  for (const [name, intervalMs, initialDelayMs, fails] of tasks) {
    schedule.registerMaintenanceTask(
      name,
      async () => {
        runs.push(name);
        if (fails) throw new Error('boom');
      },
      { intervalMs, initialDelayMs, now: T0, onError: () => errors.push(name) }
    );
  }
  const steps = [];
  for (const [offset, probe] of ticks) {
    idle = probe;
    steps.push({ at: offset, idle, ...(await schedule.runMaintenanceTasks({ now: T0 + offset })) });
  }
  delete globalThis[STATE_KEY];
  return { tasks, steps, runs, errors };
}

const HOUR = 60 * MIN;
const { cleanupIntervalMs: I, cleanupInitialDelayMs: D } = constants;
const scheduleCases = [
  // The worktree cleanup as the daemon registers it: nothing before 3 minutes, then hourly from each run.
  await timeline(
    [['worktree-cleanup', I, D, false]],
    [[0, true], [D - 1, true], [D, true], [D + 1, true], [D + I - 1, true], [D + I, true], [D + 2 * I + 5, true], [D + 3 * I, true]].map(([a, b]) => [a, b])
  ),
  // Busy at the due moment: nothing runs and the task stays due for the next idle tick.
  await timeline([['worktree-cleanup', I, D, false]], [[D, false], [D + MIN, false], [D + 2 * MIN, true], [D + 3 * MIN, true], [D + 2 * MIN + I, true]]),
  // A failing task is reported and rescheduled like a successful one.
  await timeline([['worktree-cleanup', I, D, true]], [[D, true], [D + 1, true], [D + I, true]]),
  // Two tasks: both run when idle, in registration order; each reschedules from its own run.
  await timeline([['a', 10 * MIN, 0, false], ['b', 30 * MIN, 5 * MIN, false]], [[0, true], [5 * MIN, true], [10 * MIN, true], [35 * MIN, true]]),
];

// ---- the cleanup's selection ----------------------------------------------------------------
const maintenance = await importFrom(tree, 'src/runtime/shared/worktrees/maintenance.mjs');
const DAY = 24 * HOUR;
const NOW = 1_000 * DAY;
const row = (id, ageDays, extra = {}) => ({
  id,
  repoCommonDir: '/r/.git',
  kind: 'branch',
  state: 'ready',
  dirty: 0,
  unmerged: 0,
  createdAt: NOW - ageDays * DAY,
  ...extra,
});
const settings = (maxWorktrees, unusedDays, autoCleanup = true) => ({ autoCleanup, maxWorktrees, unusedDays });
const selectCases = [
  { rows: [row('a', 10), row('b', 5), row('c', 1)], settings: settings(1, 7) },
  { rows: [row('a', 10), row('b', 5), row('c', 1)], settings: settings(1, 7, false) },
  { rows: [row('a', 10), row('b', 5), row('c', 1)], settings: settings(0, 0) },
  {
    rows: [
      row('dirty', 10, { dirty: 1 }),
      row('unmerged', 10, { unmerged: 2 }),
      row('live', 10, { ownerLive: true }),
      row('busy', 10, { inUse: true }),
      row('shared', 10, { sharedSessionIds: ['s'] }),
      row('favorite', 10, { ownerSessionId: 'fav' }),
      row('young', 0, { createdAt: NOW - 60_000 }),
      row('exactly-an-hour', 0, { createdAt: NOW - HOUR }),
      row('snap', 10, { kind: 'snapshot' }),
      row('creating', 10, { state: 'creating' }),
      row('ok', 10),
    ],
    settings: settings(0, 1),
    favoriteSessionIds: ['fav'],
  },
  {
    rows: [row('old-turn', 40, { ownerSessionId: 's1' }), row('new-turn', 40, { ownerSessionId: 's2' }), row('none', 40)],
    settings: settings(0, 30),
    activity: { s1: NOW - 2 * DAY, s2: NOW - 40 * DAY },
  },
  { rows: [row('z', 3), row('y', 3), row('x', 3)], settings: settings(1, 0) },
  {
    rows: [row('other', 20, { repoCommonDir: '/o/.git' }), row('mine1', 9), row('mine2', 8)],
    settings: settings(1, 0),
    repoCommonDir: '/r/.git',
  },
  { rows: Array.from({ length: 25 }, (_, i) => row(`w${String(i).padStart(2, '0')}`, 40 + i)), settings: settings(0, 30) },
  { rows: Array.from({ length: 25 }, (_, i) => row(`w${String(i).padStart(2, '0')}`, 40 + i)), settings: settings(0, 30), maxRemovals: 3 },
  { rows: [row('a', 10), row('b', 5), row('c', 1, { dirty: 1 })], settings: settings(1, 0), potential: true },
].map((input) => {
  const { rows, settings: s, favoriteSessionIds = [], activity = {}, repoCommonDir = null, maxRemovals, potential = false } = input;
  return {
    input,
    selected: maintenance.selectWorktreeCleanup(rows, {
      settings: s,
      now: NOW,
      activity: Object.fromEntries(Object.entries(activity).map(([id, at]) => [id, { lastActiveAt: at }])),
      favoriteSessionIds,
      potential,
      repoCommonDir,
      ...(maxRemovals === undefined ? {} : { maxRemovals }),
    }),
  };
});
const worktreeConstants = {
  minAgeMs: maintenance.WORKTREE_CLEANUP_MIN_AGE_MS,
  maxRemovals: maintenance.WORKTREE_CLEANUP_MAX_REMOVALS,
};

// ---- the attachment census ----------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'record-maintenance-jobs-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const store = await importFrom(tree, 'src/runtime/attachments/store.mjs');
const storeSource = readFileSync(join(tree, 'src/runtime/attachments/store.mjs'), 'utf8');
const gcConstant = (name) => evalMs(new RegExp(`const ${name} = ([\\d* _]+);`).exec(storeSource)[1]);
const MIN_AGE = 7 * DAY;
const now = Date.now();
const blobs = [
  // name, age in ms, referenced by (session log, checkpoint journal, none)
  ['orphan-old', 8 * DAY, null],
  ['orphan-older', 100 * DAY, null],
  ['orphan-fresh', 6 * DAY, null],
  ['orphan-today', 0, null],
  // The boundary: Node collects a blob whose mtime is at or before `now - minAge`.
  ['orphan-just-over', MIN_AGE + 1000, null],
  ['orphan-exactly-min-age', MIN_AGE, null],
  ['orphan-just-under', MIN_AGE - 1000, null],
  ['kept-by-session', 30 * DAY, 'sessions/sess_a.log.jsonl'],
  ['kept-by-session-too', 30 * DAY, 'sessions/sess_a.log.jsonl'],
  ['kept-by-checkpoint', 30 * DAY, 'turn-checkpoints/sess_a.jsonl'],
  ['kept-by-set-aside-log', 30 * DAY, 'sessions/sess_b.log.jsonl.damaged-123-ab12'],
  ['fresh-and-referenced', DAY, 'sessions/sess_a.log.jsonl'],
];
const refOf = (name) => createHash('sha256').update(`blob ${name}`).digest('hex');
const age = (path, ms) => utimesSync(path, new Date(now - ms), new Date(now - ms));
const referencing = new Map();
for (const [name, ageMs, file] of blobs) {
  const ref = refOf(name);
  const dir = join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ref), `blob ${name}`);
  age(join(dir, ref), ageMs);
  if (file) referencing.set(file, [...(referencing.get(file) ?? []), ref]);
}
// What a writer that died between create and rename leaves beside a blob: `<ref>.mixdog-tmp-<rand>`
// or the older `.<ref>.<rand>.tmp` / `<ref>.<pid>.<rand>.tmp`. Removed once as old as a collectable blob.
const owner = refOf('writer-owner');
const leftovers = [
  [`${owner}.mixdog-tmp-ab12`, 8 * DAY],
  [`${owner}.mixdog-tmp-ab12`.replace('ab12', 'cd34'), MIN_AGE],
  [`${owner}.mixdog-tmp-ef56`, MIN_AGE - 1000],
  [`${owner}.mixdog-tmp-0a`, DAY],
  [`.${owner}.9f8e7d.tmp`, 8 * DAY],
  [`${owner}.4242.9f8e7d.tmp`, 8 * DAY],
  [`${owner}.4242.9f8e7d.tmp`.replace('4242', '4343'), DAY],
  // Not a leftover pattern: kept however old.
  [`${owner}.mixdog-tmp-`, 100 * DAY],
  [`${owner}.mixdog-tmp-XYZ`, 100 * DAY],
  [`${owner}.other`, 100 * DAY],
  [`${owner}.tmp`, 100 * DAY],
  [`${owner.slice(1)}.1.tmp`, 100 * DAY],
  // Temp-named files that are no blob's: only a 64-hex blob ref before the suffix qualifies.
  ['.notes.tmp-0123456789abcdef', 100 * DAY],
  ['notes.mixdog-tmp-ab12', 100 * DAY],
  ['.notes.9f8e7d.tmp', 100 * DAY],
  [`.${owner.toUpperCase()}.tmp-0123456789abcdef`, 100 * DAY],
];
const leftoverDir = join(dataDir, 'prompt-attachments', 'sha256', owner.slice(0, 2));
mkdirSync(leftoverDir, { recursive: true });
for (const [name, ageMs] of leftovers) {
  writeFileSync(join(leftoverDir, name), 'partial');
  age(join(leftoverDir, name), ageMs);
}
for (const [file, refs] of referencing) {
  mkdirSync(join(dataDir, file, '..'), { recursive: true });
  writeFileSync(join(dataDir, file), refs.map((ref) => JSON.stringify({ part: { attachmentRef: ref } })).join('\n'));
}
const report = await store.collectPromptAttachments({ now, minAgeMs: MIN_AGE });
const attachments = {
  minAgeMs: MIN_AGE,
  blobs: blobs.map(([name, ageMs, file]) => ({
    name,
    ageMs,
    referenced: Boolean(file),
    kept: existsSync(join(dataDir, 'prompt-attachments', 'sha256', refOf(name).slice(0, 2), refOf(name))),
  })),
  leftovers: leftovers.map(([name, ageMs]) => ({
    name: name.replaceAll(owner, '<ref>').replaceAll(owner.slice(1), '<ref-1>'),
    ageMs,
    kept: existsSync(join(leftoverDir, name)),
  })),
  report: { deleted: report.deleted, referenced: report.referenced, fresh: report.fresh, scanned: report.scanned },
  constants: {
    spacingMs: gcConstant('ATTACHMENT_GC_SPACING_MS'),
    startDelayMs: gcConstant('ATTACHMENT_GC_START_DELAY_MS'),
    defaultMinAgeMs: 7 * DAY,
  },
};
rmSync(dataDir, { recursive: true, force: true });

writeJson(join(FIXTURES_ROOT, 'maintenance-jobs', 'golden.json'), {
  T0,
  constants,
  schedule: scheduleCases,
  worktree: { NOW, constants: worktreeConstants, select: selectCases },
  attachments,
});
writeSetManifest(join(FIXTURES_ROOT, 'maintenance-jobs'), {
  set: 'maintenance-jobs',
  recorder,
  command: `node ${recorder} --tree <tree>`,
  identityTree: tree,
});
console.log(`maintenance jobs: ${scheduleCases.length} schedules, ${selectCases.length} selections, ${blobs.length} blobs`);
