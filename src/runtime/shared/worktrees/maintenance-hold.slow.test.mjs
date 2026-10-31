// The automatic worktree cleanup against real git: the scan never holds the
// folder, and the checks under the hold keep a worktree that changed meanwhile.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { configureWorktreeManager } from './manager.mjs';
import { runWorktreeCleanup, setArchivedSessionWorktrees } from './maintenance.mjs';
import { tryAdmitWorkspaceActivityAsync } from './activity-gate.mjs';
import { getRecord, putRecord } from './registry.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree as create,
  git,
  makeRepo,
  useTempDataDir,
} from './test-support.mjs';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
let restore = () => {};

function configure(settings = {}, extra = {}) {
  restore();
  restore = configureWorktreeManager({
    settings,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
    ...extra,
  });
}

beforeEach(() => {
  useTempDataDir();
  configure();
});
afterEach(() => restore());
after(() => cleanupTempDirs());

async function backdate(entry, ageMs) {
  await putRecord({ ...(await getRecord(entry.id)), createdAt: Date.now() - ageMs });
}

/** Worktrees whose owners stay stored, with their sessions' last activity `idle` ago. */
async function setup(repo, names) {
  const made = {};
  for (const [name, { idleMs = 10 * DAY, ageMs = idleMs } = {}] of Object.entries(names)) {
    made[name] = await create(repo, { nameHint: name });
    await backdate(made[name].entry, ageMs);
    made[name].idleMs = idleMs;
  }
  const now = Date.now();
  return {
    made,
    options: (extra = {}) => ({
      listSessionIds: async () => Object.values(made).map((item) => item.sessionId),
      readActivity: async () =>
        Object.fromEntries(Object.values(made).map((item) => [item.sessionId, { lastActiveAt: now - item.idleMs }])),
      readFavorites: async () => [],
      listJobs: async () => [],
      ...extra,
    }),
  };
}

test('a turn arriving while cleanup scans a dirty worktree is admitted at once (the folder is not held for the scan)', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, { dirty: { idleMs: 2 * HOUR } });
  configure({ maxWorktrees: 0, unusedDays: 0 });
  await setArchivedSessionWorktrees([made.dirty.sessionId], true);
  // Enough untracked files that the status scan takes a while.
  for (let i = 0; i < 1500; i += 1) writeFileSync(join(made.dirty.entry.path, `scratch-${i}.txt`), `${i}\n`);
  let done = false;
  const cleanup = runWorktreeCleanup(options()).finally(() => {
    done = true;
  });
  let attempts = 0;
  let refused = 0;
  while (!done) {
    const leave = await tryAdmitWorkspaceActivityAsync('turn-session', made.dirty.entry.path);
    attempts += 1;
    if (leave) await leave();
    else refused += 1;
  }
  const report = await cleanup;
  assert.ok(attempts > 0);
  assert.equal(refused, 0, 'no turn waited through the scan');
  assert.ok(report.kept.some((item) => item.id === made.dirty.entry.id && item.reason === 'dirty'));
});

test('a worktree that changes between the checks and the hold is kept for a later pass', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, { moving: { idleMs: 2 * HOUR } });
  configure({ maxWorktrees: 0, unusedDays: 0 });
  await setArchivedSessionWorktrees([made.moving.sessionId], true);
  // inUse runs under the hold, after the checks: a commit lands in between.
  let committed = false;
  const report = await runWorktreeCleanup(
    options({
      currentLiveSessionIds: () => {
        if (!committed) {
          committed = true;
          git(made.moving.entry.path, 'commit', '-q', '--allow-empty', '-m', 'late work');
        }
        return [];
      },
    })
  );
  assert.deepEqual(report.removed, []);
  assert.ok(report.kept.some((item) => item.id === made.moving.entry.id && item.reason === 'changed'));
  assert.ok(existsSync(made.moving.entry.path));
});

/** One clean archived worktree and a pass whose hold-time hook runs `between` once. */
async function changeUnderHold(between, extra = {}) {
  const repo = makeRepo();
  // A tracked subfolder: writing into it leaves the checkout root's mtime alone.
  commitFile(repo, 'deep/nested/keep.txt', 'keep\n');
  const { made, options } = await setup(repo, { target: { idleMs: 2 * HOUR } });
  configure({ maxWorktrees: 0, unusedDays: 0 });
  await setArchivedSessionWorktrees([made.target.sessionId], true);
  let ran = false;
  const report = await runWorktreeCleanup(
    options({
      // Asked under the hold, after the checks and before the final status.
      currentLiveSessionIds: () => {
        if (!ran) {
          ran = true;
          between(made.target.entry.path);
        }
        return [];
      },
      ...extra,
    })
  );
  return { report, entry: made.target.entry };
}

test('a nested untracked file created between the scan and the hold keeps the worktree', async () => {
  const { report, entry } = await changeUnderHold((path) => {
    writeFileSync(join(path, 'deep', 'nested', 'new.txt'), 'new\n');
  });
  assert.deepEqual(report.removed, []);
  assert.ok(report.kept.some((item) => item.id === entry.id && item.reason === 'dirty'));
  assert.equal(readFileSync(join(entry.path, 'deep', 'nested', 'new.txt'), 'utf8'), 'new\n');
});

test('an unstaged edit of a tracked file between the scan and the hold keeps the worktree', async () => {
  const { report, entry } = await changeUnderHold((path) => writeFileSync(join(path, 'README.md'), 'edited\n'));
  assert.deepEqual(report.removed, []);
  assert.ok(report.kept.some((item) => item.id === entry.id && item.reason === 'dirty'));
  assert.equal(readFileSync(join(entry.path, 'README.md'), 'utf8'), 'edited\n');
});

test('a final dirty check that does not finish in time keeps the worktree', async () => {
  const { report, entry } = await changeUnderHold(() => {}, { finalCheckTimeoutMs: 1 });
  assert.deepEqual(report.removed, []);
  assert.ok(report.kept.some((item) => item.id === entry.id && item.reason === 'busy'));
  assert.ok(existsSync(entry.path));
});

test('an ignored file created between the scan and the hold keeps the worktree', async () => {
  const { report, entry } = await changeUnderHold((path) => {
    // info/exclude of the common git dir applies to the worktree too.
    writeFileSync(resolve(path, git(path, 'rev-parse', '--git-path', 'info/exclude')), '.env\n');
    writeFileSync(join(path, 'deep', 'nested', '.env'), 'SECRET=1\n');
  });
  assert.deepEqual(report.removed, []);
  const kept = report.kept.find((item) => item.id === entry.id);
  assert.equal(kept?.reason, 'ignored');
  assert.deepEqual(kept.files, ['deep/nested/.env']);
  assert.equal(readFileSync(join(entry.path, 'deep', 'nested', '.env'), 'utf8'), 'SECRET=1\n');
});

test('with nothing changed the final check passes and the worktree goes', async () => {
  const { report, entry } = await changeUnderHold(() => {});
  assert.deepEqual(report.removed, [entry.id]);
});

test('a timed-out final check has no git left running when the worktree is kept', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, { slow: { idleMs: 2 * HOUR } });
  configure({ maxWorktrees: 0, unusedDays: 0 });
  await setArchivedSessionWorktrees([made.slow.sessionId], true);
  const report = await runWorktreeCleanup(options({ finalCheckTimeoutMs: 1 }));
  const kept = report.kept.find((item) => item.id === made.slow.entry.id);
  assert.equal(kept?.reason, 'busy');
  assert.equal(kept.gitRunning, undefined, 'the killed git status exited before the hold was released');
});
