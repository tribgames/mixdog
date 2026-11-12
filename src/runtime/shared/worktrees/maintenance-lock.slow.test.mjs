// The automatic cleanup against real git: its keep-or-remove checks run
// outside the repository lock, only the removal holds it (re-validated there),
// and a kept verdict is never carried over to a later pass.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { claimWorktreeOwner, configureWorktreeManager, removeManagedWorktree, withRepoLock } from './manager.mjs';
import { cleanupDeletedSessionWorktree, runWorktreeCleanup, setArchivedSessionWorktrees } from './maintenance.mjs';
import { getRecord, putRecord } from './registry.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree as create,
  git,
  makeRepo,
  tempDir,
  useTempDataDir,
} from './test-support.mjs';

const HOUR = 60 * 60_000;
const SLOW_MS = 4_000;
let restore = () => {};

beforeEach(() => {
  useTempDataDir();
  restore = configureWorktreeManager({
    settings: { maxWorktrees: 0, unusedDays: 0 },
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
});
afterEach(() => {
  restore();
});
after(() => cleanupTempDirs());

/** Archived (disposable) worktrees of stored sessions, old enough for the cleanup. */
async function archived(repo, names) {
  const made = {};
  for (const name of names) {
    made[name] = await create(repo, { nameHint: name });
    await putRecord({ ...(await getRecord(made[name].entry.id)), createdAt: Date.now() - 2 * HOUR });
  }
  await setArchivedSessionWorktrees(
    Object.values(made).map((item) => item.sessionId),
    true
  );
  const options = (extra = {}) => ({
    listSessionIds: async () => Object.values(made).map((item) => item.sessionId),
    readActivity: async () => ({}),
    readFavorites: async () => [],
    listJobs: async () => [],
    ...extra,
  });
  return { made, options };
}

/**
 * The first `git status` of `path` hashing README.md sleeps SLOW_MS in a
 * clean filter (later ones pass straight through); `started` exists once it
 * sleeps. `attributes` is where the filter is assigned: the worktree's own
 * (untracked, so dirty) .gitattributes, or the common info/attributes (clean).
 */
function slowFirstStatus(repo, path, { untracked }) {
  const dir = tempDir('mixdog-wt-slow-');
  const started = join(dir, 'started');
  const done = join(dir, 'done');
  const filter = join(dir, 'slow.cjs');
  writeFileSync(
    filter,
    `const fs = require('node:fs');\n` +
      `const chunks = [];\n` +
      `process.stdin.on('data', (c) => chunks.push(c)).on('end', () => {\n` +
      `  const out = () => process.stdout.write(Buffer.concat(chunks));\n` +
      `  if (fs.existsSync(${JSON.stringify(done)})) return out();\n` +
      `  fs.writeFileSync(${JSON.stringify(started)}, '');\n` +
      `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(done)}, ''); out(); }, ${SLOW_MS});\n` +
      `});\n`
  );
  const command = `"${process.execPath.replace(/\\/g, '/')}" "${filter.replace(/\\/g, '/')}"`;
  git(repo, 'config', 'filter.slow.clean', command);
  const attributes = untracked
    ? join(path, '.gitattributes')
    : resolve(path, git(path, 'rev-parse', '--git-path', 'info/attributes'));
  writeFileSync(attributes, 'README.md filter=slow\n');
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(path, 'README.md'), later, later);
  return { started: () => existsSync(started) };
}

async function until(check) {
  while (!check()) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
}

test('a claim and a creation in the repository do not wait while the cleanup checks a slow worktree', async () => {
  const repo = makeRepo();
  const { made, options } = await archived(repo, ['slow', 'other']);
  const slow = slowFirstStatus(repo, made.slow.entry.path, { untracked: true });
  let done = false;
  const pass = runWorktreeCleanup(options()).finally(() => {
    done = true;
  });
  await until(slow.started);
  await claimWorktreeOwner(made.other.entry.id, { sessionId: made.other.sessionId, runtimeToken: 'late', pid: 1 });
  assert.equal(done, false, 'the claim did not wait for the pass');
  const fresh = await create(repo, { nameHint: 'fresh' });
  assert.equal(done, false, 'the creation did not wait for the pass');
  const report = await pass;
  assert.ok(report.kept.some((item) => item.id === made.slow.entry.id && item.reason === 'dirty'));
  assert.ok(existsSync(fresh.entry.path));
});

test("a deleted session's cleanup checks a slow worktree without holding the repository lock", async () => {
  const repo = makeRepo();
  const { made } = await archived(repo, ['slow', 'other']);
  const slow = slowFirstStatus(repo, made.slow.entry.path, { untracked: true });
  let done = false;
  const pass = cleanupDeletedSessionWorktree(made.slow.sessionId, { autoCleanup: true, deleteBranch: false }).finally(
    () => {
      done = true;
    }
  );
  await until(slow.started);
  await claimWorktreeOwner(made.other.entry.id, { sessionId: made.other.sessionId, runtimeToken: 'late', pid: 1 });
  assert.equal(done, false, 'the claim did not wait for the cleanup');
  const fresh = await create(repo, { nameHint: 'fresh' });
  assert.equal(done, false, 'the creation did not wait for the cleanup');
  const result = await pass;
  assert.deepEqual([result.removed, result.reason], [false, 'WORKTREE_DIRTY']);
  assert.ok(existsSync(made.slow.entry.path));
  assert.ok(existsSync(fresh.entry.path));
});

/**
 * Start an automatic removal of `entry` while the repository lock is held
 * elsewhere, run `meanwhile` (record changes) during the wait, then release.
 */
async function removeWhileLockHeld(entry, meanwhile) {
  let release;
  const held = new Promise((resolveHeld) => {
    release = resolveHeld;
  });
  let acquired;
  const taken = new Promise((resolveTaken) => {
    acquired = resolveTaken;
  });
  const lock = withRepoLock(entry.repoCommonDir, async () => {
    acquired();
    await held;
  });
  await taken;
  const removal = removeManagedWorktree({ entryId: entry.id, automatic: true, preserveBranch: true });
  const settled = removal.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await meanwhile();
  release();
  await lock;
  return settled;
}

const branchTip = (repo, branch) => git(repo, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`);

test('a creating worktree that becomes ready while its removal waits takes the automatic path', async () => {
  const repo = makeRepo();
  const made = await create(repo, { nameHint: 'racing' });
  const ready = await getRecord(made.entry.id);
  await putRecord({ ...ready, state: 'creating' });
  const { value, error } = await removeWhileLockHeld(ready, () => putRecord(ready));
  assert.equal(error, undefined);
  assert.equal(value.removed, true);
  assert.equal(existsSync(made.entry.path), false);
  assert.equal(branchTip(repo, made.entry.branch), made.entry.branch, 'preserveBranch holds');
});

test('a ready worktree that becomes creating while its removal waits is decided by the locked path', async () => {
  const repo = makeRepo();
  const made = await create(repo, { nameHint: 'racing' });
  const ready = await getRecord(made.entry.id);
  // Dirty: had the stale automatic route run, it would refuse WORKTREE_DIRTY.
  writeFileSync(join(made.entry.path, 'wip.txt'), 'wip\n');
  const { value, error } = await removeWhileLockHeld(ready, () => putRecord({ ...ready, state: 'creating' }));
  assert.equal(error?.code, undefined, 'not refused by the automatic checks');
  assert.equal(value.removed, true, 'the creating record is rolled back under the lock');
  assert.equal(existsSync(made.entry.path), false);
});

test('a state flip-flop while the removal waits ends in one decision', async () => {
  const repo = makeRepo();
  const made = await create(repo, { nameHint: 'racing' });
  const ready = await getRecord(made.entry.id);
  const { value, error } = await removeWhileLockHeld(ready, async () => {
    for (let round = 0; round < 6; round += 1) {
      await putRecord({ ...ready, state: round % 2 === 0 ? 'creating' : 'ready' });
    }
  });
  assert.equal(error, undefined);
  assert.equal(value.removed, true);
  assert.equal(existsSync(made.entry.path), false);
});

test('a worktree claimed while the cleanup checks it is kept, and the claim holds', async () => {
  const repo = makeRepo();
  const { made, options } = await archived(repo, ['target']);
  const slow = slowFirstStatus(repo, made.target.entry.path, { untracked: false });
  const pass = runWorktreeCleanup(options());
  await until(slow.started);
  const claim = await claimWorktreeOwner(made.target.entry.id, {
    sessionId: made.target.sessionId,
    runtimeToken: 'returning',
    pid: 1,
  });
  const report = await pass;
  assert.equal(claim.lease.runtimeToken, 'returning');
  assert.deepEqual(report.removed, []);
  assert.ok(report.kept.some((item) => item.id === made.target.entry.id));
  assert.ok(existsSync(made.target.entry.path));
});

test('a worktree made dirty after the cleanup checked it is kept', async () => {
  const repo = makeRepo();
  commitFile(repo, 'deep/nested/keep.txt', 'keep\n');
  const { made, options } = await archived(repo, ['target']);
  const slow = slowFirstStatus(repo, made.target.entry.path, { untracked: false });
  const pass = runWorktreeCleanup(options());
  await until(slow.started);
  writeFileSync(join(made.target.entry.path, 'deep', 'nested', 'new.txt'), 'new\n');
  writeFileSync(join(made.target.entry.path, 'deep', 'nested', 'keep.txt'), 'edited\n');
  const report = await pass;
  assert.deepEqual(report.removed, []);
  assert.ok(report.kept.some((item) => item.id === made.target.entry.id && item.reason === 'dirty'));
  assert.equal(readFileSync(join(made.target.entry.path, 'deep', 'nested', 'new.txt'), 'utf8'), 'new\n');
});

test('removing the nested untracked file that kept a worktree lets the next automatic pass remove it', async () => {
  const repo = makeRepo();
  const { made, options } = await archived(repo, ['target']);
  const { path } = made.target.entry;
  const file = join(path, 'deep', 'nested', 'work.txt');
  mkdirSync(join(path, 'deep', 'nested'), { recursive: true });
  writeFileSync(file, 'work\n');

  const one = await runWorktreeCleanup(options());
  assert.deepEqual(one.removed, []);
  assert.ok(one.kept.some((item) => item.id === made.target.entry.id && item.reason === 'dirty'));
  const two = await runWorktreeCleanup(options());
  assert.ok(two.kept.some((item) => item.id === made.target.entry.id && item.reason === 'dirty'));

  // Neither HEAD, the index, the folder's own mtime nor a branch tip changes.
  rmSync(file);
  const three = await runWorktreeCleanup(options());
  assert.deepEqual(three.removed, [made.target.entry.id]);
  assert.equal(existsSync(path), false);
});
