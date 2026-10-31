// The automatic worktree cleanup against real git: the count/age limits, the
// never-remove rules, the toggles, branch keeping and the empty branch prefix.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { configureWorktreeManager } from './manager.mjs';
import { cleanupDeletedSessionWorktree, runWorktreeCleanup, setArchivedSessionWorktrees } from './maintenance.mjs';
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
  // deleteBranch off (the default): the removed worktree's branch stays.
  assert.ok(branchExists(repo, made.oldest.entry.branch));
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

test('deleteBranch on: the branch goes and its tip stays under the recovery ref', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, { gone: { idleMs: 90 * DAY } });
  const tip = git(repo, 'rev-parse', made.gone.entry.branch);
  configure({ maxWorktrees: 0, unusedDays: 30, deleteBranch: true });
  assert.deepEqual((await runWorktreeCleanup(options())).removed, [made.gone.entry.id]);
  assert.equal(branchExists(repo, made.gone.entry.branch), false);
  assert.equal(git(repo, 'rev-parse', `refs/mixdog/removed/${made.gone.entry.id}`), tip);
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
  configure({ maxWorktrees: 0, unusedDays: 30, deleteBranch: true });
  const report = await runWorktreeCleanup({
    listSessionIds: async () => [named.sessionId, nested.sessionId, opened.sessionId],
    readActivity: async () => ({}),
    readFavorites: async () => [],
    listJobs: async () => [],
  });
  assert.deepEqual(report.removed.sort(), [named.entry.id, nested.entry.id, opened.entry.id].sort());
  assert.equal(branchExists(repo, 'fix-login-2'), false, 'its own branch goes');
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

test('one budget per pass: 21 eligible archived worktrees, 20 removed', async () => {
  const repo = makeRepo();
  const names = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`arch-${i}`, { idleMs: 2 * HOUR }]));
  const { made, options } = await setup(repo, names);
  configure({ maxWorktrees: 0, unusedDays: 0 });
  await setArchivedSessionWorktrees(
    Object.values(made).map((item) => item.sessionId),
    true
  );
  const report = await runWorktreeCleanup(options());
  assert.equal(report.removed.length, 20);
  assert.equal(report.kept.filter((item) => item.reason === 'budget').length, 1);
  const second = await runWorktreeCleanup(options());
  assert.equal(second.removed.length, 1, 'the rest goes in the next pass');
});

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

test('with nothing changed the final check passes and the worktree goes', async () => {
  const { report, entry } = await changeUnderHold(() => {});
  assert.deepEqual(report.removed, [entry.id]);
});

// `git worktree remove --force` refusing (a held file, a permission, an
// unexpected state): the automatic cleanup's one deleting step fails.
const failingGitRemove = {
  gitWorktreeRemove: async () => ({ code: 128, stdout: '', stderr: 'fatal: simulated refusal' }),
};

test('automatic cleanup whose git removal fails keeps the folder, records it incomplete and re-verifies next pass', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, { blocked: { idleMs: 2 * HOUR } });
  const { entry } = made.blocked;
  configure({ maxWorktrees: 0, unusedDays: 0 }, failingGitRemove);
  await setArchivedSessionWorktrees([made.blocked.sessionId], true);
  const first = await runWorktreeCleanup(options());
  assert.deepEqual(first.removed, []);
  const kept = first.kept.find((item) => item.id === entry.id);
  assert.equal(kept?.reason, 'incomplete');
  assert.ok(kept.remaining.some((item) => item.kind === 'git-remove' && /simulated refusal/.test(item.error)));
  // No recursive delete: the checkout is exactly as it was.
  assert.equal(readFileSync(join(entry.path, 'README.md'), 'utf8'), 'hello\n');
  assert.ok(existsSync(join(entry.path, '.git')));
  const record = await getRecord(entry.id);
  assert.equal(record.state, 'ready', 'not a decided deletion a later pass would resume blindly');
  assert.equal(record.removalIncomplete.reason, 'git-remove-failed');
  // The next pass verifies it afresh: work written meanwhile keeps it, no removal is attempted.
  writeFileSync(join(entry.path, 'meanwhile.txt'), 'work\n');
  let attempts = 0;
  configure(
    { maxWorktrees: 0, unusedDays: 0 },
    {
      gitWorktreeRemove: async () => {
        attempts += 1;
        return { code: 128, stdout: '', stderr: 'fatal: simulated refusal' };
      },
    }
  );
  const second = await runWorktreeCleanup(options());
  assert.ok(second.kept.some((item) => item.id === entry.id && item.reason === 'dirty'));
  assert.equal(attempts, 0);
  assert.ok(existsSync(join(entry.path, 'meanwhile.txt')));
  // Clean again and git willing: the following pass removes it through git.
  rmSync(join(entry.path, 'meanwhile.txt'));
  configure({ maxWorktrees: 0, unusedDays: 0 });
  const third = await runWorktreeCleanup(options());
  assert.deepEqual(third.removed, [entry.id]);
  assert.equal(existsSync(entry.path), false);
});

test("a deleted session's leftover whose git removal fails is kept the same way", async () => {
  const repo = makeRepo();
  const made = await create(repo, { nameHint: 'leftover' });
  configure({}, failingGitRemove);
  const result = await cleanupDeletedSessionWorktree(made.sessionId);
  assert.equal(result.removed, false);
  assert.equal(result.incomplete, true);
  assert.equal(readFileSync(join(made.entry.path, 'README.md'), 'utf8'), 'hello\n');
  assert.equal((await getRecord(made.entry.id)).state, 'ready');
});

test('an interrupted automatic removal is not resumed: back to ready, verified afresh', async () => {
  const repo = makeRepo();
  const { made, options } = await setup(repo, { cut: { idleMs: 2 * HOUR } });
  const { entry } = made.cut;
  await putRecord({
    ...(await getRecord(entry.id)),
    state: 'deleting',
    deleting: { force: false, automatic: true, startedAt: Date.now(), remaining: [] },
  });
  writeFileSync(join(entry.path, 'unsaved.txt'), 'keep me\n');
  configure({ maxWorktrees: 0, unusedDays: 0 });
  const report = await runWorktreeCleanup(options());
  assert.ok(report.kept.some((item) => item.id === entry.id && item.reason === 'incomplete'));
  assert.equal((await getRecord(entry.id)).state, 'ready');
  assert.equal(readFileSync(join(entry.path, 'unsaved.txt'), 'utf8'), 'keep me\n');
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

/** A repository whose worktrees get a recorded include link (`config.json`) and Mixdog's lock. */
function repoWithIncludeLink() {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', 'config.json\n');
  writeFileSync(join(repo, 'config.json'), '{"cfg":1}\n');
  writeFileSync(join(repo, '.worktreeinclude'), 'link config.json\n');
  return repo;
}

const lockedBy = (repo, sessionId) =>
  new RegExp(`locked mixdog session=${sessionId}`).test(git(repo, 'worktree', 'list', '--porcelain'));

test('a removal that rejects (timeout, spawn error) puts back the links and the lock and is recorded incomplete', async () => {
  const repo = repoWithIncludeLink();
  const { made, options } = await setup(repo, { rejected: { idleMs: 2 * HOUR } });
  const { entry, sessionId } = made.rejected;
  const linked = join(entry.path, 'config.json');
  assert.ok(existsSync(linked));
  assert.ok(lockedBy(repo, sessionId));
  configure(
    { maxWorktrees: 0, unusedDays: 0 },
    {
      gitWorktreeRemove: async () => {
        // The attempt had already taken the link and the lock apart.
        assert.equal(existsSync(linked), false);
        assert.equal(lockedBy(repo, sessionId), false);
        throw Object.assign(new Error('git worktree remove timed out after 30000ms'), { code: 'ETIMEDOUT' });
      },
    }
  );
  await setArchivedSessionWorktrees([sessionId], true);
  const report = await runWorktreeCleanup(options());
  const kept = report.kept.find((item) => item.id === entry.id);
  assert.equal(kept?.reason, 'incomplete');
  assert.ok(kept.remaining.some((item) => item.kind === 'git-remove' && /timed out/.test(item.error)));
  assert.equal(readFileSync(linked, 'utf8'), '{"cfg":1}\n', 'the link is back');
  assert.ok(lockedBy(repo, sessionId), 'the lock is back');
  assert.equal((await getRecord(entry.id)).state, 'ready');
});

test('an automatic removal interrupted after taking links and lock apart is put back on restart', async () => {
  const repo = repoWithIncludeLink();
  const { made, options } = await setup(repo, { cut: { idleMs: 2 * HOUR } });
  const { entry, sessionId } = made.cut;
  const linked = join(entry.path, 'config.json');
  // The process died between unlinking/unlocking and git's removal.
  await putRecord({
    ...(await getRecord(entry.id)),
    state: 'deleting',
    deleting: {
      force: false,
      automatic: true,
      undo: { links: true, lock: `mixdog session=${sessionId}` },
      startedAt: Date.now(),
      remaining: [],
    },
  });
  rmSync(linked);
  git(repo, 'worktree', 'unlock', entry.path);
  assert.equal(lockedBy(repo, sessionId), false);
  configure({ maxWorktrees: 0, unusedDays: 0 });
  const report = await runWorktreeCleanup(options());
  assert.ok(report.kept.some((item) => item.id === entry.id && item.reason === 'incomplete'));
  const record = await getRecord(entry.id);
  assert.equal(record.state, 'ready');
  assert.equal(record.removalIncomplete.reason, 'interrupted');
  assert.equal(readFileSync(linked, 'utf8'), '{"cfg":1}\n', 'the link is back');
  assert.ok(lockedBy(repo, sessionId), 'the lock is back');
});
