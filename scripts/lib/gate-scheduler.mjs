import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

// The local gate runs every lane from one shared pool of workers: each lane's
// files are cut into shards, and whichever worker is free takes the longest
// shard left, whatever its lane. Shard sizes come from the previous run's
// measured per-file times, so the split stays balanced without hand-kept
// weights, and no worker idles while another lane still has work.

// The gate runs its whole process tree at below-normal priority, so a
// foreground app always wins the CPU. Priority does not bound what the
// desktop shell shares with every process (handles, desktop heap, work
// queues; explorer.exe has failed with "no work queue available" under many
// concurrent test processes), so the default also caps the worker count:
// half the cores, leaving the other half for what the budget does not count
// (each shard's runner, the processes tests spawn, the desktop build's own
// threads), and never more than DEFAULT_MAX_WORKERS. Each worker is three
// node processes (shard runner, its node --test batch, the test file) plus
// whatever the test spawns. Measured on a 20-core Windows PC with other work
// running: at 10 workers, test-file processes began dying within ~20 ms with
// no output (every remaining file of a shard, in 2 of 2 runs); at 8 and 6
// they did not.
// An explicit budget still wins: --test-concurrency (gate argument), then
// MIXDOG_TEST_CONCURRENCY.
const DEFAULT_MAX_WORKERS = 8;
export function gateTestBudget(argv = [], env = process.env, parallelism = availableParallelism()) {
  const index = argv.findIndex((arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='));
  let explicit = env.MIXDOG_TEST_CONCURRENCY || undefined;
  // A flag without a value is an error, not "unspecified".
  if (index >= 0) explicit = argv[index].includes('=') ? argv[index].split('=')[1] : (argv[index + 1] ?? '');
  if (explicit === undefined) return Math.max(1, Math.min(DEFAULT_MAX_WORKERS, Math.floor(parallelism / 2)));
  const budget = Number(explicit);
  if (!Number.isInteger(budget) || budget < 1) throw new Error(`gate test budget must be a positive integer (got "${explicit}")`);
  return budget;
}

// Estimates for work with no recorded time yet: the next run records it.
export const DEFAULT_ESTIMATE_MS = { fast: 2_000, slow: 25_000, command: 60_000 };

// Previous runs' measured times ({ version, ms: { key: ms } }). A missing,
// unreadable or malformed file counts as no history, and an entry that is
// not a finite positive number is dropped (its work gets the default).
export function readTimingHistory(file) {
  let ms;
  try {
    ms = JSON.parse(readFileSync(file, 'utf8'))?.ms;
  } catch {
    return {};
  }
  if (!ms || typeof ms !== 'object' || Array.isArray(ms)) return {};
  return Object.fromEntries(
    Object.entries(ms).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
  );
}

// Writes the history through a temp file of its own (concurrent gates in
// other worktrees share the file) and renames it into place. Never throws:
// returns the error, or null once saved; the timings only plan the next run.
export function saveTimingHistory(file, ms) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 1, ms })}\n`);
    renameSync(temp, file);
    return null;
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The save error is the one reported.
    }
    return error;
  }
}
// Enough shards per worker that the pool's tail (the shards still running
// when the queue is empty) stays short; the floor bounds the per-shard runner
// start-up and process sweep (~1-2 s each).
const SHARDS_PER_WORKER = 8;
const MIN_SHARD_MS = 15_000;

// test.mjs selects every lane file whose path contains a given filter, so a
// file whose path contains another file's path has to share that file's shard
// or it would run twice. Returns the indivisible groups.
export function filterGroups(files) {
  const parent = new Map(files.map((file) => [file, file]));
  const find = (file) => (parent.get(file) === file ? file : find(parent.get(file)));
  for (const inner of files) {
    for (const outer of files) if (outer !== inner && outer.includes(inner)) parent.set(find(outer), find(inner));
  }
  const groups = new Map();
  for (const file of files) groups.set(find(file), [...(groups.get(find(file)) ?? []), file]);
  return [...groups.values()];
}

// Cuts each lane ({ name, files, estimateOf }) into shards of about one
// target size, longest-first into the least-loaded shard, so a file longer
// than the target runs alone. Returns [{ lane, files, estimate }].
export function planShards(lanes, budget) {
  const total = lanes.reduce((sum, lane) => sum + lane.files.reduce((s, file) => s + lane.estimateOf(file), 0), 0);
  const target = Math.max(MIN_SHARD_MS, total / (budget * SHARDS_PER_WORKER));
  const shards = [];
  for (const lane of lanes) {
    const items = filterGroups(lane.files)
      .map((files) => ({ files, estimate: files.reduce((s, file) => s + lane.estimateOf(file), 0) }))
      .sort((a, b) => b.estimate - a.estimate);
    const laneTotal = items.reduce((sum, item) => sum + item.estimate, 0);
    const bins = Array.from({ length: Math.min(items.length, Math.max(1, Math.round(laneTotal / target))) }, () => ({
      lane: lane.name,
      files: [],
      estimate: 0,
    }));
    for (const item of items) {
      const bin = bins.reduce((least, candidate) => (candidate.estimate < least.estimate ? candidate : least));
      bin.files.push(...item.files);
      bin.estimate += item.estimate;
    }
    shards.push(...bins);
  }
  return shards;
}

// Per-file time of a finished shard: what its own tests reported plus an
// equal share of the rest of the shard's wall time (process start-up, module
// load, the runner's own work). Returns { file: ms }.
export function measuredFileTimes(files, reportedMs, wallMs) {
  const reported = files.reduce((sum, file) => sum + (reportedMs[file] ?? 0), 0);
  const overhead = Math.max(0, wallMs - reported) / files.length;
  return Object.fromEntries(files.map((file) => [file, (reportedMs[file] ?? 0) + overhead]));
}

// Runs every unit on `budget` workers, longest estimate first. A failed unit
// marked stopOnFail stops new starts (running units finish). Returns the
// units never started.
export async function runPool(units, budget, run) {
  if (!Number.isInteger(budget) || budget < 1) throw new Error('gate test budget must be a positive integer');
  const queue = [...units].sort((a, b) => b.estimate - a.estimate);
  let stopped = false;
  await Promise.all(
    Array.from({ length: Math.min(budget, queue.length) }, async () => {
      while (!stopped && queue.length > 0) {
        const unit = queue.shift();
        unit.ok = await run(unit);
        if (!unit.ok && unit.stopOnFail) stopped = true;
      }
    })
  );
  return queue;
}
