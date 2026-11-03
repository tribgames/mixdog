// The automatic worktree cleanup against real git: the count/age limits, the
// never-remove rules, the toggles, branch keeping and the empty branch prefix.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { configureWorktreeManager } from './manager.mjs';
import { runWorktreeCleanup, setArchivedSessionWorktrees } from './maintenance.mjs';
import { tryAdmitWorkspaceActivityAsync } from './activity-gate.mjs';
import { getRecord, putRecord } from './registry.mjs';
import { cleanupTempDirs, createTestWorktree as create, git, makeRepo, useTempDataDir } from './test-support.mjs';

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

const branchExists = (repo, branch) =>
  git(repo, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`) === branch;

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

test('count limit: the least recently used eligible worktree goes; favorite, live, dirty and young ones never do', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, {
    favorite: { idleMs: 90 * DAY },
    live: { idleMs: 80 * DAY },
    dirty: { idleMs: 70 * DAY },
    young: { ageMs: 10 * 60_000, idleMs: 60 * DAY },
    oldest: { idleMs: 20 * DAY },
    newer: { idleMs: 2 * DAY },
  });
  writeFileSync(join(made.dirty.entry.path, 'wip.txt'), 'wip\n');
  configure({ maxWorktrees: 5, unusedDays: 0 });
  const report = await runWorktreeCleanup(
    options({ liveSessionIds: [made.live.sessionId], readFavorites: async () => [made.favorite.sessionId] })
  );
  assert.deepEqual(
    report.selected.map((row) => [row.id, row.reason]),
    [[made.oldest.entry.id, 'count']]
  );
  assert.deepEqual(report.removed, [made.oldest.entry.id]);
  assert.equal(existsSync(made.oldest.entry.path), false);
  for (const name of ['favorite', 'live', 'dirty', 'young', 'newer'])
    assert.ok(existsSync(made[name].entry.path), name);
  assert.ok(existsSync(join(made.dirty.entry.path, 'wip.txt')));
  // The removed worktree's merged branch, made by Mixdog, goes with it.
  assert.equal(branchExists(repo, made.oldest.entry.branch), false);
});

test('age limit: worktrees unused past the limit go; a running job in a folder keeps it', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, {
    stale: { idleMs: 40 * DAY },
    busy: { idleMs: 45 * DAY },
    fresh: { idleMs: 3 * DAY },
  });
  configure({ maxWorktrees: 0, unusedDays: 30 });
  const report = await runWorktreeCleanup(
    options({ listJobs: async () => [{ cwd: join(made.busy.entry.path, 'src'), ownerSessionId: null }] })
  );
  assert.deepEqual(report.removed, [made.stale.entry.id]);
  assert.ok(existsSync(made.busy.entry.path));
  assert.ok(existsSync(made.fresh.entry.path));
});

test('toggles: autoCleanup off or unknown favorites remove nothing by the limits', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, { a: { idleMs: 90 * DAY }, b: { idleMs: 80 * DAY } });
  configure({ autoCleanup: false, maxWorktrees: 1, unusedDays: 1 });
  const off = await runWorktreeCleanup(options());
  assert.deepEqual([off.removed, off.selected], [[], []]);
  configure({ maxWorktrees: 1, unusedDays: 1 });
  const unknown = await runWorktreeCleanup(options({ readFavorites: async () => null }));
  assert.equal(unknown.limits, 'favorites-unknown');
  assert.deepEqual(unknown.removed, []);
  for (const { entry } of Object.values(made)) assert.ok(existsSync(entry.path));
});

test('empty prefix: a user branch named like the task is never reused, overwritten or deleted', async () => {
  const repo = makeRepo();
  git(repo, 'branch', 'fix-login');
  git(repo, 'branch', 'feature-x');
  git(repo, 'branch', 'nested/old');
  const userTip = git(repo, 'rev-parse', 'fix-login');
  const named = await create(repo, { nameHint: 'Fix login' });
  assert.equal(named.entry.branch, 'fix-login-2');
  assert.equal(git(repo, 'rev-parse', 'fix-login'), userTip);
  // `nested` would be a ref directory of the user's nested/old: the next name is taken.
  const nested = await create(repo, { nameHint: 'nested' });
  assert.equal(nested.entry.branch, 'nested-2');
  // A worktree opened on the user's own branch: cleanup never deletes that branch.
  const opened = await create(repo, { branch: 'feature-x', existingBranch: true });
  for (const { entry } of [named, nested, opened]) await backdate(entry, 90 * DAY);
  configure({ maxWorktrees: 0, unusedDays: 30 });
  const report = await runWorktreeCleanup({
    listSessionIds: async () => [named.sessionId, nested.sessionId, opened.sessionId],
    readActivity: async () => ({}),
    readFavorites: async () => [],
    listJobs: async () => [],
  });
  assert.deepEqual(report.removed.sort(), [named.entry.id, nested.entry.id, opened.entry.id].sort());
  assert.equal(branchExists(repo, 'fix-login-2'), false, 'its own merged branch goes');
  assert.equal(branchExists(repo, 'nested-2'), false);
  assert.equal(git(repo, 'rev-parse', 'fix-login'), userTip);
  assert.ok(branchExists(repo, 'feature-x'), "the user's branch stays");
  assert.ok(branchExists(repo, 'nested/old'));
});

test('archive cleanup with the count/age limits off still keeps a folder a job runs in', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, { archived: { idleMs: 2 * HOUR }, other: { idleMs: 2 * HOUR } });
  configure({ maxWorktrees: 0, unusedDays: 0 });
  await setArchivedSessionWorktrees([made.archived.sessionId, made.other.sessionId], true);
  // Another session's background command runs inside the archived worktree.
  const jobs = async () => [{ cwd: join(made.archived.entry.path, 'pkg'), ownerSessionId: 'someone-else' }];
  const report = await runWorktreeCleanup(options({ listJobs: jobs }));
  assert.deepEqual(report.removed, [made.other.entry.id]);
  assert.ok(existsSync(made.archived.entry.path));
});

test('a turn admitted in a folder, or a session that went live during the pass, keeps it', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, {
    admitted: { idleMs: 90 * DAY },
    returning: { idleMs: 90 * DAY },
    idle: { idleMs: 90 * DAY },
  });
  configure({ maxWorktrees: 0, unusedDays: 30 });
  // A turn started in `admitted` before the removal reached it.
  const leave = await tryAdmitWorkspaceActivityAsync('turn-session', made.admitted.entry.path);
  assert.ok(leave);
  // `returning` opened its session after the pass began (not in liveSessionIds).
  let opened = false;
  try {
    const report = await runWorktreeCleanup(
      options({
        readActivity: async (ids) => {
          opened = true;
          return Object.fromEntries(ids.map((id) => [id, { lastActiveAt: Date.now() - 90 * DAY }]));
        },
        currentLiveSessionIds: () => (opened ? [made.returning.sessionId] : []),
      })
    );
    assert.deepEqual(report.removed, [made.idle.entry.id]);
    assert.ok(report.kept.some((item) => item.id === made.admitted.entry.id && item.reason === 'in-use'));
    assert.ok(report.kept.some((item) => item.id === made.returning.entry.id && item.reason === 'in-use'));
    assert.ok(existsSync(made.admitted.entry.path));
    assert.ok(existsSync(made.returning.entry.path));
  } finally {
    await leave();
  }
});
