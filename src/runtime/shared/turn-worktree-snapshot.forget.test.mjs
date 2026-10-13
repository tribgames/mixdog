import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

const root = mkdtempSync(join(tmpdir(), 'mixdog-turn-worktree-forget-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});

const { createTurnWorktreeSnapshot, forgetTurnWorktreeRoot, refreshTurnWorktreeSnapshot } = await import(
  './turn-worktree-snapshot.mjs'
);

const shadowRoot = join(process.env.MIXDOG_DATA_DIR, 'turn-worktree-snapshots-v1');
const shadowDirs = () => (existsSync(shadowRoot) ? readdirSync(shadowRoot) : []);

function makeRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  const run = (...args) => {
    const result = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  };
  run('init', '-q');
  run('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  run('add', '-A');
  run('commit', '-qm', 'seed');
  return repo;
}

test('forgetTurnWorktreeRoot removes only the target shadow repository and refuses late writes', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repoA = makeRepo('repo-a');
  const repoB = makeRepo('repo-b');
  const snapA = await createTurnWorktreeSnapshot(repoA);
  const snapB = await createTurnWorktreeSnapshot(repoB);
  assert.equal(shadowDirs().length, 2);

  // A capture still queued when the root is forgotten finishes first; the
  // removal serializes behind it instead of racing it.
  writeFileSync(join(repoA, 'a.txt'), 'changed\n');
  const pending = refreshTurnWorktreeSnapshot(snapA, { force: true });
  const forgotten = forgetTurnWorktreeRoot(process.platform === 'win32' ? repoA.toUpperCase() : repoA);
  assert.equal((await pending).files.length, 1);
  const result = await forgotten;
  assert.equal(result.removed.length, 1);
  assert.deepEqual(result.kept, []);
  assert.equal(shadowDirs().length, 1);

  // A snapshot object that outlived the forget cannot recreate the directory.
  await assert.rejects(refreshTurnWorktreeSnapshot(snapA, { force: true }), { code: 'TURN_WORKTREE_SNAPSHOT_REMOVED' });
  assert.equal(shadowDirs().length, 1);

  // Idempotent, and the other root is untouched and still works.
  assert.deepEqual(await forgetTurnWorktreeRoot(repoA), { removed: [], kept: [] });
  assert.equal((await refreshTurnWorktreeSnapshot(snapB, { force: true })).files.length, 0);
  assert.equal(shadowDirs().length, 1);

  // A later snapshot of the same path starts a fresh repository.
  assert.ok(await createTurnWorktreeSnapshot(repoA));
  assert.equal(shadowDirs().length, 2);
});
