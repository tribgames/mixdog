import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRepoLockKey, withGitRepoWriteLock, withGitWorktreeWriteLock } from './git-repo-rw-lock.mjs';

test('git repo lock keys are canonical: real path, trailing separators, Windows casing', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-rw-key-'));
  try {
    const dir = join(root, 'Repo', '.git');
    mkdirSync(dir, { recursive: true });
    const key = gitRepoLockKey(dir);
    assert.equal(gitRepoLockKey(`${dir}/`), key);
    assert.equal(gitRepoLockKey(join(dir, 'x', '..')), key);
    assert.equal(gitRepoLockKey(realpathSync.native(dir)), key);
    if (process.platform === 'win32') {
      assert.equal(gitRepoLockKey(dir.toUpperCase()), key);
      assert.equal(gitRepoLockKey(dir.replace(/\\/g, '/')), key);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function gate() {
  let release;
  return {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
    release,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function holder(events, name) {
  const hold = gate();
  return {
    release: hold.release,
    run: async () => {
      events.push(`${name}:start`);
      await hold.promise;
      events.push(`${name}:end`);
    },
  };
}

test('writes on different worktrees run together; writes on one worktree run one at a time in order', async () => {
  const repo = `repo-scope-${Date.now()}-${Math.random()}`;
  const events = [];
  const a1 = holder(events, 'a1');
  const a2 = holder(events, 'a2');
  const b = holder(events, 'b');
  const first = withGitWorktreeWriteLock(repo, ['wt-a'], a1.run);
  const second = withGitWorktreeWriteLock(repo, ['wt-a'], a2.run);
  const other = withGitWorktreeWriteLock(repo, ['wt-b'], b.run);
  await settle();
  assert.deepEqual(events, ['a1:start', 'b:start']);
  a1.release();
  await first;
  await settle();
  assert.deepEqual(events, ['a1:start', 'b:start', 'a1:end', 'a2:start']);
  a2.release();
  b.release();
  await Promise.all([second, other]);
});

test('a write naming several worktrees conflicts with a write on any of them', async () => {
  const repo = `repo-multi-${Date.now()}-${Math.random()}`;
  const events = [];
  const move = holder(events, 'move');
  const moving = withGitWorktreeWriteLock(repo, ['wt-a', 'wt-new'], move.run);
  const onA = withGitWorktreeWriteLock(repo, ['wt-a'], () => events.push('a'));
  const onNew = withGitWorktreeWriteLock(repo, ['wt-new'], () => events.push('new'));
  const onB = withGitWorktreeWriteLock(repo, ['wt-b'], () => events.push('b'));
  await onB;
  await settle();
  assert.deepEqual(events, ['move:start', 'b']);
  move.release();
  await Promise.all([moving, onA, onNew]);
  assert.deepEqual(events, ['move:start', 'b', 'move:end', 'a', 'new']);
});

test('a waiting whole-repository write is never starved by later worktree writes', async () => {
  const repo = `repo-starve-${Date.now()}-${Math.random()}`;
  const events = [];
  const a = holder(events, 'a');
  const whole = holder(events, 'repo');
  const running = withGitWorktreeWriteLock(repo, ['wt-a'], a.run);
  const repoWrite = withGitRepoWriteLock(repo, whole.run);
  // wt-b conflicts with nothing running, but it would overtake the waiting
  // whole-repository write, so it queues behind it.
  const later = [
    withGitWorktreeWriteLock(repo, ['wt-b'], () => events.push('b')),
    withGitWorktreeWriteLock(repo, ['wt-a'], () => events.push('a2')),
  ];
  await settle();
  assert.deepEqual(events, ['a:start']);
  a.release();
  await running;
  await settle();
  assert.deepEqual(events, ['a:start', 'a:end', 'repo:start']);
  whole.release();
  await Promise.all([repoWrite, ...later]);
  assert.deepEqual(events, ['a:start', 'a:end', 'repo:start', 'repo:end', 'b', 'a2']);
});

test('a later write that conflicts with nothing ahead of it is not held back by a queue', async () => {
  const repo = `repo-convoy-${Date.now()}-${Math.random()}`;
  const events = [];
  const a = holder(events, 'a');
  const running = withGitWorktreeWriteLock(repo, ['wt-a'], a.run);
  const queued = withGitWorktreeWriteLock(repo, ['wt-a'], () => events.push('a2'));
  await withGitWorktreeWriteLock(repo, ['wt-b'], () => events.push('b'));
  assert.deepEqual(events, ['a:start', 'b']);
  a.release();
  await Promise.all([running, queued]);
  assert.deepEqual(events, ['a:start', 'b', 'a:end', 'a2']);
});

test('worktree scopes are canonical paths; an empty scope holds the whole repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-rw-scope-'));
  try {
    const worktree = join(root, 'Worktree');
    mkdirSync(worktree);
    const repo = join(root, '.git');
    const events = [];
    const hold = holder(events, 'held');
    const held = withGitWorktreeWriteLock(repo, [worktree], hold.run);
    const spelled = withGitWorktreeWriteLock(
      repo,
      [process.platform === 'win32' ? `${worktree.toUpperCase()}\\` : `${worktree}/`],
      () => events.push('same')
    );
    const whole = withGitWorktreeWriteLock(repo, [], () => events.push('whole'));
    await settle();
    assert.deepEqual(events, ['held:start']);
    hold.release();
    await Promise.all([held, spelled, whole]);
    assert.deepEqual(events, ['held:start', 'held:end', 'same', 'whole']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git repo writers on different repositories run in parallel', async () => {
  const hold = gate();
  const events = [];
  const first = withGitRepoWriteLock('repo-a', async () => {
    events.push('a');
    await hold.promise;
  });
  const second = withGitRepoWriteLock('repo-b', async () => {
    events.push('b');
    await hold.promise;
  });
  await Promise.resolve();
  assert.deepEqual(events.sort(), ['a', 'b']);
  hold.release();
  await Promise.all([first, second]);
});

test('a queued git repo lock aborts without running or blocking later work', async () => {
  const repo = `repo-abort-${Date.now()}-${Math.random()}`;
  const hold = gate();
  const writer = withGitWorktreeWriteLock(repo, ['wt-a'], () => hold.promise);
  await Promise.resolve();

  const controller = new AbortController();
  let ran = false;
  const queued = withGitRepoWriteLock(
    repo,
    async () => {
      ran = true;
    },
    { signal: controller.signal }
  );
  // Queued behind the waiting whole-repository write until that one aborts.
  const behind = withGitWorktreeWriteLock(repo, ['wt-b'], () => 'b');
  controller.abort();
  await assert.rejects(queued, /abort/i);
  assert.equal(ran, false);
  assert.equal(await behind, 'b');

  hold.release();
  await writer;
  await withGitRepoWriteLock(repo, async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
