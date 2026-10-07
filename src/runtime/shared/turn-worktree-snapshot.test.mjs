import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

// The shadow repositories live under MIXDOG_DATA_DIR, resolved at import.
const root = mkdtempSync(join(tmpdir(), 'mixdog-turn-worktree-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});

const { createTurnWorktreeSnapshot, refreshTurnWorktreeSnapshot, revertTurnWorktreeSnapshot } = await import(
  './turn-worktree-snapshot.mjs'
);

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

test('turn worktree snapshots spawn git off the event loop and keep their contents', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async (t) => {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  // Exact LF bytes regardless of the machine's global line-ending config.
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'a.txt'), 'original a\n');
  writeFileSync(join(repo, 'b.txt'), 'original b\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');

  const mainThreadSpawns = [];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, ...args) => {
    mainThreadSpawns.push(command);
    return spawn(command, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const snapshot = await createTurnWorktreeSnapshot(repo);
  assert.match(snapshot.baselineTree, /^[0-9a-f]{40,64}$/);
  writeFileSync(join(repo, 'a.txt'), 'changed a\n');
  rmSync(join(repo, 'b.txt'));
  writeFileSync(join(repo, 'new.txt'), 'new file\n');
  await refreshTurnWorktreeSnapshot(snapshot);

  assert.deepEqual(
    snapshot.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
    [
      { path: 'a.txt', status: 'M', additions: 1, deletions: 1 },
      { path: 'b.txt', status: 'D', additions: 0, deletions: 1 },
      { path: 'new.txt', status: 'A', additions: 1, deletions: 0 },
    ]
  );
  assert.match(snapshot.patch, /^\+changed a$/m);
  assert.equal(snapshot.patchTruncated, false);

  await revertTurnWorktreeSnapshot(snapshot);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'original a\n');
  assert.equal(readFileSync(join(repo, 'b.txt'), 'utf8'), 'original b\n');
  assert.equal(existsSync(join(repo, 'new.txt')), false);
  assert.deepEqual(snapshot.files, []);

  assert.deepEqual(mainThreadSpawns, [], 'git was spawned on the event loop thread');
});

test('an autocrlf checkout touched without edits is not a diff', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = join(root, 'crlf-repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'true');
  writeFileSync(join(repo, 'a.txt'), 'one\r\ntwo\r\nthree\r\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');

  const snapshot = await createTurnWorktreeSnapshot(repo);
  // Same CRLF bytes, new mtime: the shadow index sees a stat-dirty entry.
  writeFileSync(join(repo, 'a.txt'), 'one\r\ntwo\r\nthree\r\n');
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(repo, 'a.txt'), later, later);
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.deepEqual(snapshot.files, []);

  writeFileSync(join(repo, 'a.txt'), 'one\r\nTWO\r\nthree\r\n');
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.deepEqual(
    snapshot.files.map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    [{ path: 'a.txt', additions: 1, deletions: 1 }]
  );

  await revertTurnWorktreeSnapshot(snapshot);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\r\ntwo\r\nthree\r\n');
});

test('a directory outside any repository yields no snapshot', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const plain = join(root, 'plain');
  mkdirSync(plain, { recursive: true });
  assert.equal(await createTurnWorktreeSnapshot(plain), null);
});
