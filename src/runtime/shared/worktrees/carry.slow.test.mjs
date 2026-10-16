// The project folder's uncommitted changes when a new managed worktree is
// created: `ask` refuses while there are any (tracked and untracked counted),
// `leave` keeps them in place, `carry` moves them (staged, unstaged, deleted,
// untracked, binary) into the worktree and clears the project folder, a
// failed carry restores the project folder exactly and keeps a recovery ref,
// and a merge in progress refuses `carry` but not `leave`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { configureWorktreeManager, dropCarryRecoveryRef, restoreCarriedChanges } from './manager.mjs';
import { readRegistry } from './registry.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree,
  git,
  makeRepo,
  prefixedBranches,
  tempDir,
  useTempDataDir,
  writeFile,
} from './test-support.mjs';

let restore = () => {};

beforeEach(() => {
  useTempDataDir();
  restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
});

afterEach(() => restore());
after(() => cleanupTempDirs());

const BINARY = Buffer.from([0, 1, 2, 255, 0, 10, 13, 10, 0, 254]);
const BINARY_EDIT = Buffer.from([9, 0, 0, 255, 13, 10, 0, 7]);
const UNTRACKED_BINARY = Buffer.from([0, 0, 128, 64, 13, 0, 10]);

/** Status rows (porcelain v1, every untracked file), sorted. */
function status(dir) {
  return git(dir, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean).sort();
}

const read = (dir, rel) => readFileSync(join(dir, ...rel.split('/')));

/**
 * A repository with every kind of change: unstaged and staged edits, a staged
 * addition, unstaged and staged deletions, a binary edit, untracked text and
 * binary files (in new folders), and an ignored file that is never counted.
 */
function dirtyRepo() {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', '*.log\n');
  commitFile(repo, 'keep.txt', 'keep\n');
  commitFile(repo, 'gone.txt', 'gone\n');
  commitFile(repo, 'staged-gone.txt', 'staged gone\n');
  writeFileSync(join(repo, 'img.bin'), BINARY);
  git(repo, 'add', 'img.bin');
  git(repo, 'commit', '-q', '-m', 'binary');
  writeFile(repo, 'README.md', 'hello\nmore\n');
  writeFile(repo, 'keep.txt', 'staged\n');
  git(repo, 'add', 'keep.txt');
  writeFile(repo, 'keep.txt', 'staged\nunstaged\n');
  writeFile(repo, 'added.txt', 'added\n');
  git(repo, 'add', 'added.txt');
  rmSync(join(repo, 'gone.txt'));
  git(repo, 'rm', '-q', 'staged-gone.txt');
  writeFileSync(join(repo, 'img.bin'), BINARY_EDIT);
  writeFile(repo, 'notes/todo.md', 'todo\n');
  writeFile(repo, 'assets/blob.bin', UNTRACKED_BINARY);
  writeFile(repo, 'debug.log', 'ignored\n');
  return repo;
}

const CHANGED_FILES = ['README.md', 'keep.txt', 'added.txt', 'img.bin', 'notes/todo.md', 'assets/blob.bin'];
const COUNT = 8;

function contents(dir) {
  return Object.fromEntries(CHANGED_FILES.map((rel) => [rel, read(dir, rel).toString('base64')]));
}

function stagedKeep(dir) {
  return git(dir, 'show', ':keep.txt');
}

test('ask: a dirty project folder refuses with the count of changed paths, tracked and untracked', async () => {
  const repo = dirtyRepo();
  const before = status(repo);
  await assert.rejects(createTestWorktree(repo, { carryChanges: 'ask' }), (error) => {
    assert.equal(error.code, 'WORKTREE_DIRTY_CHOICE');
    assert.equal(error.details.count, COUNT);
    assert.deepEqual(
      [...error.details.paths].sort(),
      [...CHANGED_FILES, 'gone.txt', 'staged-gone.txt'].sort(),
      'the preview lists the changed paths, ignored files excluded'
    );
    return true;
  });
  assert.deepEqual(status(repo), before);
  assert.deepEqual(prefixedBranches(repo), [], 'nothing was created');
  assert.deepEqual(Object.keys((await readRegistry()).entries), []);
});

test('ask: a clean project folder proceeds without a choice', async () => {
  const repo = makeRepo();
  writeFile(repo, 'debug.log', 'ignored files never count\n');
  commitFile(repo, '.gitignore', '*.log\n');
  const { entry } = await createTestWorktree(repo, { carryChanges: 'ask' });
  assert.equal(entry.state, 'ready');
  assert.equal(entry.changes, undefined);
});

test('leave: the worktree starts at HEAD and the project folder keeps its changes untouched', async () => {
  const repo = dirtyRepo();
  const before = status(repo);
  const files = contents(repo);
  const { entry } = await createTestWorktree(repo, { carryChanges: 'leave' });
  assert.deepEqual(entry.changes, { mode: 'left', count: COUNT });
  assert.deepEqual(status(repo), before);
  assert.deepEqual(contents(repo), files);
  assert.deepEqual(status(entry.path), [], 'the worktree is clean');
  assert.equal(git(entry.path, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'HEAD'));
});

test('carry: every kind of change moves into the worktree and the project folder ends clean', async () => {
  const repo = dirtyRepo();
  const before = status(repo);
  const files = contents(repo);
  const { entry } = await createTestWorktree(repo, { carryChanges: 'carry' });
  const { recoveryRef } = entry.changes;
  assert.deepEqual(entry.changes, { mode: 'carried', count: COUNT, recoveryRef });
  assert.deepEqual(status(repo), [], 'the project folder is clean');
  assert.equal(read(repo, 'debug.log').toString(), 'ignored\n', 'ignored files stay');
  assert.equal(existsSync(join(repo, 'notes')), false, 'folders emptied by the carry are removed');
  assert.deepEqual(status(entry.path), before, 'staged, unstaged and untracked states are identical');
  assert.deepEqual(contents(entry.path), files, 'contents (binary included) are identical');
  assert.equal(stagedKeep(entry.path), 'staged', 'the staged version is kept apart from the unstaged one');
  assert.equal(existsSync(join(entry.path, 'gone.txt')), false);
  assert.equal(existsSync(join(entry.path, 'staged-gone.txt')), false);
  assert.equal(existsSync(join(entry.path, 'debug.log')), false, 'ignored files are not carried');
  // The recovery ref outlives the carry until the session move is committed;
  // a move that fails later puts everything back from it.
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/mixdog/carry/'), recoveryRef);
  await restoreCarriedChanges({ projectPath: repo, recoveryRef });
  assert.deepEqual(status(repo), before, 'restored from the recovery ref');
  assert.deepEqual(contents(repo), files);
  assert.equal(stagedKeep(repo), 'staged');
  await dropCarryRecoveryRef({ projectPath: repo, recoveryRef });
  assert.equal(git(repo, 'for-each-ref', 'refs/mixdog/carry/'), '');
});

test('carry: a restore from the recovery ref never overwrites a project folder that changed meanwhile', async () => {
  const repo = dirtyRepo();
  const { entry } = await createTestWorktree(repo, { carryChanges: 'carry' });
  writeFile(repo, 'later.txt', 'new work\n');
  await assert.rejects(
    restoreCarriedChanges({ projectPath: repo, recoveryRef: entry.changes.recoveryRef }),
    (error) => {
      assert.equal(error.code, 'WORKTREE_DIRTY');
      assert.equal(error.details.reason, 'carry-restore-refused');
      return true;
    }
  );
  assert.deepEqual(status(repo), ['?? later.txt']);
  assert.ok(git(repo, 'rev-parse', '--verify', entry.changes.recoveryRef), 'the ref is kept');
});

test('carry scope is the whole checkout: a Project in a subfolder moves edits outside it too', async () => {
  const repo = makeRepo();
  commitFile(repo, 'packages/app/index.js', 'app\n');
  commitFile(repo, '.gitignore', '.mixdog/\n');
  const project = join(repo, 'packages', 'app');
  writeFile(project, '.mixdog/project.id', 'pid-sub\n');
  writeFile(project, 'index.js', 'app edited\n');
  writeFile(repo, 'README.md', 'root edit outside the project\n');
  writeFile(repo, 'tools/new.sh', 'echo\n');
  const before = status(repo);
  await assert.rejects(createTestWorktree(project, { carryChanges: 'ask' }), (error) => {
    assert.equal(error.details.count, 3, 'detection counts edits outside the Project folder');
    return true;
  });
  const { entry } = await createTestWorktree(project, { carryChanges: 'carry' });
  assert.equal(entry.changes.count, 3);
  assert.deepEqual(status(repo), [], 'the whole checkout is clean');
  assert.deepEqual(status(entry.path), before, 'the same changes, project and outside, are in the worktree');
  assert.equal(read(entry.path, 'README.md').toString(), 'root edit outside the project\n');
  assert.equal(read(project, '.mixdog/project.id').toString(), 'pid-sub\n', 'the identity file stays');
});

test('carry refuses changed submodules and filtered (LFS-style) paths; leave is unaffected', async () => {
  const repo = makeRepo();
  commitFile(repo, '.gitattributes', 'secret.txt filter=custom\n');
  commitFile(repo, 'secret.txt', 'one\n');
  writeFile(repo, 'secret.txt', 'two\n');
  await assert.rejects(createTestWorktree(repo, { carryChanges: 'carry' }), (error) => {
    assert.equal(error.code, 'WORKTREE_DIRTY');
    assert.equal(error.details.reason, 'filtered-paths');
    assert.deepEqual(error.details.paths, ['secret.txt']);
    return true;
  });
  git(repo, 'checkout', '-q', '--', 'secret.txt');

  const inner = join(repo, 'inner');
  git(repo, 'init', '-q', '-b', 'main', 'inner');
  git(inner, 'config', 'user.name', 'Mixdog Test');
  git(inner, 'config', 'user.email', 'mixdog@example.com');
  commitFile(inner, 'a.txt', 'a\n');
  git(repo, 'add', 'inner');
  git(repo, 'commit', '-q', '-m', 'gitlink');
  commitFile(inner, 'a.txt', 'b\n');
  await assert.rejects(createTestWorktree(repo, { carryChanges: 'carry' }), (error) => {
    assert.equal(error.details.reason, 'dirty-submodules');
    assert.deepEqual(error.details.paths, ['inner']);
    return true;
  });
  assert.deepEqual(prefixedBranches(repo), []);
  const { entry } = await createTestWorktree(repo, { carryChanges: 'leave' });
  assert.deepEqual(entry.changes, { mode: 'left', count: 1 });
});

test('carry failure: the project folder is restored exactly, the worktree is rolled back, a recovery ref is kept', async () => {
  const repo = dirtyRepo();
  const before = status(repo);
  const files = contents(repo);
  // The project folder's index is locked: clearing it fails after the
  // worktree already holds the changes.
  const lock = join(repo, '.git', 'index.lock');
  writeFileSync(lock, '');
  let recoveryRef = null;
  try {
    await assert.rejects(createTestWorktree(repo, { carryChanges: 'carry' }), (error) => {
      assert.equal(error.code, 'WORKTREE_DIRTY');
      assert.equal(error.details.reason, 'carry-failed');
      assert.equal(error.details.restored, true);
      assert.match(error.details.recoveryRef, /^refs\/mixdog\/carry\/fix-the-login-page-\d+$/);
      assert.ok(error.message.includes(error.details.recoveryRef), 'the message names the recovery ref');
      recoveryRef = error.details.recoveryRef;
      return true;
    });
  } finally {
    rmSync(lock, { force: true });
  }
  assert.deepEqual(status(repo), before);
  assert.deepEqual(contents(repo), files);
  assert.equal(stagedKeep(repo), 'staged');
  assert.deepEqual(prefixedBranches(repo), [], 'the worktree branch was rolled back');
  assert.deepEqual(Object.keys((await readRegistry()).entries), []);
  assert.equal(git(repo, 'show', `${recoveryRef}:notes/todo.md`), 'todo', 'the recovery ref holds untracked files');
  assert.equal(git(repo, 'show', `${recoveryRef}^2:keep.txt`), 'staged', 'its second parent holds the index');
});

/** Top-level git processes started while `action` runs (git's own trace2 events; children excluded). */
async function countGitProcesses(action) {
  const traceFile = join(tempDir('mixdog-wt-trace-'), 'trace2.json');
  process.env.GIT_TRACE2_EVENT = traceFile;
  try {
    await action();
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
  }
  return readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === 'version' && !String(event.sid).includes('/')).length;
}

// Every git spawn costs ~0.1 s on Windows, so a carry's wall time is its
// spawn count: it used to read the status five times, list untracked files
// three times and probe the identity file in every step (~65 spawns).
const LEAVE_GIT_PROCESSES = 13;
const CARRY_GIT_PROCESSES = 44;

test('carry stays within a bounded number of git invocations, independent of the number of changed files', async () => {
  const leaveRepo = dirtyRepo();
  const leave = await countGitProcesses(() => createTestWorktree(leaveRepo, { carryChanges: 'leave' }));
  assert.ok(leave <= LEAVE_GIT_PROCESSES, `leave started ${leave} git processes (limit ${LEAVE_GIT_PROCESSES})`);

  const repo = dirtyRepo();
  for (let i = 0; i < 25; i++) writeFile(repo, `bulk/file-${i}.txt`, `bulk ${i}\n`);
  const before = status(repo);
  let carried;
  const carry = await countGitProcesses(async () => {
    carried = await createTestWorktree(repo, { carryChanges: 'carry' });
  });
  assert.equal(carried.entry.changes.mode, 'carried');
  assert.ok(carry <= CARRY_GIT_PROCESSES, `carry started ${carry} git processes (limit ${CARRY_GIT_PROCESSES})`);
  assert.deepEqual(status(carried.entry.path), before, 'the worktree holds every carried change');
  assert.deepEqual(status(repo), [], 'the project folder is cleared');
  await dropCarryRecoveryRef({ projectPath: repo, recoveryRef: carried.entry.changes.recoveryRef });
});

/** `carry` is refused with `reason` (and `extra` details) before anything is created or touched. */
async function assertCarryRefused(repo, reason, extra = {}) {
  const before = status(repo);
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(createTestWorktree(repo, { carryChanges: 'carry' }), (error) => {
    assert.equal(error.code, 'WORKTREE_DIRTY');
    assert.equal(error.details.reason, reason);
    for (const [key, value] of Object.entries(extra)) assert.deepEqual(error.details[key], value, key);
    return true;
  });
  assert.deepEqual(prefixedBranches(repo), [], 'no worktree was created');
  assert.deepEqual(Object.keys((await readRegistry()).entries), []);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(status(repo), before, 'the project folder is untouched');
  assert.equal(git(repo, 'for-each-ref', 'refs/mixdog/carry/'), '', 'no recovery ref was written');
}

test('carry is refused for an assume-unchanged file with local edits (status cannot see them)', async () => {
  const repo = makeRepo();
  commitFile(repo, 'hidden.txt', 'one\n');
  git(repo, 'update-index', '--assume-unchanged', 'hidden.txt');
  writeFile(repo, 'hidden.txt', 'two\n');
  assert.deepEqual(status(repo), [], 'git does not see the edit');
  await assertCarryRefused(repo, 'assume-unchanged', { paths: ['hidden.txt'] });
  assert.equal(readFileSync(join(repo, 'hidden.txt'), 'utf8'), 'two\n');
});

test('carry is refused for a skip-worktree file with local edits', async () => {
  const repo = makeRepo();
  commitFile(repo, 'hidden.txt', 'one\n');
  git(repo, 'update-index', '--skip-worktree', 'hidden.txt');
  writeFile(repo, 'hidden.txt', 'two\n');
  writeFile(repo, 'notes.md', 'visible\n');
  await assertCarryRefused(repo, 'skip-worktree', { paths: ['hidden.txt'] });
  assert.equal(readFileSync(join(repo, 'hidden.txt'), 'utf8'), 'two\n');
});

test('carry is refused in a sparse checkout', async () => {
  const repo = makeRepo();
  commitFile(repo, 'src/a.txt', 'a\n');
  git(repo, 'sparse-checkout', 'init', '--cone');
  writeFile(repo, 'README.md', 'edited\n');
  await assertCarryRefused(repo, 'sparse-checkout');
});

test('carry is refused for an intent-to-add entry (git add -N)', async () => {
  const repo = makeRepo();
  writeFile(repo, 'planned.txt', 'planned\n');
  git(repo, 'add', '-N', 'planned.txt');
  await assertCarryRefused(repo, 'intent-to-add', { paths: ['planned.txt'] });
});

test('carry is refused for an intent-to-add entry whose working file was deleted', async () => {
  const repo = makeRepo();
  writeFile(repo, 'intent.txt', 'planned\n');
  git(repo, 'add', '-N', 'intent.txt');
  rmSync(join(repo, 'intent.txt'));
  await assertCarryRefused(repo, 'intent-to-add', { paths: ['intent.txt'] });
});

test('carry is refused for an intent-to-add entry whose working file was modified', async () => {
  const repo = makeRepo();
  writeFile(repo, 'intent.txt', 'planned\n');
  git(repo, 'add', '-N', 'intent.txt');
  writeFile(repo, 'intent.txt', 'planned and then some\n');
  await assertCarryRefused(repo, 'intent-to-add', { paths: ['intent.txt'] });
});

test('carry is refused while a bisect is in progress', async () => {
  const repo = makeRepo();
  commitFile(repo, 'second.txt', 'second\n');
  git(repo, 'bisect', 'start');
  writeFile(repo, 'notes.md', 'untracked\n');
  await assertCarryRefused(repo, 'operation-in-progress', { operation: 'bisect' });
});

test('carry is refused for a pending revert sequence without REVERT_HEAD', async () => {
  const repo = makeRepo();
  const target = commitFile(repo, 'second.txt', 'second\n');
  // The state `git revert A B` leaves between two commits: only sequencer/.
  writeFile(repo, '.git/sequencer/todo', `revert ${target} second\n`);
  writeFile(repo, '.git/sequencer/head', `${target}\n`);
  writeFile(repo, 'notes.md', 'untracked\n');
  assert.equal(existsSync(join(repo, '.git', 'REVERT_HEAD')), false);
  await assertCarryRefused(repo, 'operation-in-progress', { operation: 'revert' });
});

test('carry is refused while a merge is in progress; leave is still allowed', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '-b', 'other');
  commitFile(repo, 'other.txt', 'other\n');
  git(repo, 'checkout', '-q', 'main');
  commitFile(repo, 'main.txt', 'main\n');
  git(repo, 'merge', '--no-ff', '--no-commit', 'other');
  writeFile(repo, 'notes.md', 'untracked\n');
  const before = status(repo);
  await assert.rejects(createTestWorktree(repo, { carryChanges: 'carry' }), (error) => {
    assert.equal(error.code, 'WORKTREE_DIRTY');
    assert.equal(error.details.reason, 'operation-in-progress');
    assert.equal(error.details.operation, 'merge');
    return true;
  });
  assert.deepEqual(prefixedBranches(repo), []);
  assert.deepEqual(status(repo), before);
  const { entry } = await createTestWorktree(repo, { carryChanges: 'leave' });
  assert.deepEqual(entry.changes, { mode: 'left', count: 2 });
  assert.deepEqual(status(repo), before);
  assert.ok(existsSync(join(repo, '.git', 'MERGE_HEAD')), 'the merge in progress is untouched');
});
