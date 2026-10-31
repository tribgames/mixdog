// The automatic worktree cleanup against real git: a removal that fails or is
// interrupted keeps the folder, puts back what it took apart and is verified afresh.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { configureWorktreeManager } from './manager.mjs';
import { cleanupDeletedSessionWorktree, runWorktreeCleanup, setArchivedSessionWorktrees } from './maintenance.mjs';
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
