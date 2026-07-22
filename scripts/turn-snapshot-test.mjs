import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-turn-snapshot-data-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const {
  beginTurnSnapshot,
  getTurnReviewDiff,
  _resetTurnSnapshotForTest,
} = await import('../src/runtime/shared/turn-snapshot.mjs');

test('turn snapshot diffs everything changed after the base, regardless of author', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'mixdog-turn-snapshot-wt-'));
  try {
    await writeFile(join(worktree, 'kept.txt'), 'unchanged\n');
    await writeFile(join(worktree, 'edited.txt'), 'one\ntwo\n');
    await beginTurnSnapshot(worktree, 'sess_a', { waitCapMs: 30_000 });

    // Simulate edits from ANY author (subagent/background shell/editor).
    await writeFile(join(worktree, 'edited.txt'), 'one\nTWO\nthree\n');
    await writeFile(join(worktree, 'created.txt'), 'fresh\n');

    const diff = await getTurnReviewDiff(worktree, 'sess_a');
    assert.equal(diff.supported, true);
    const names = diff.files.map((file) => file.name).sort();
    assert.deepEqual(names, ['created.txt', 'edited.txt']);
    const edited = diff.files.find((file) => file.name === 'edited.txt');
    assert.ok(edited.additions >= 2 && edited.deletions >= 1);
    assert.match(diff.patch, /\+TWO/);
    assert.match(diff.patch, /\+fresh/);

    // A fresh base resets the turn scope.
    await beginTurnSnapshot(worktree, 'sess_a', { waitCapMs: 30_000 });
    const after = await getTurnReviewDiff(worktree, 'sess_a');
    assert.deepEqual(after.files, []);
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test('gitignored and nested .git content stays out of the snapshot', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'mixdog-turn-snapshot-ign-'));
  try {
    await writeFile(join(worktree, '.gitignore'), 'node_modules/\n');
    await mkdir(join(worktree, 'node_modules'), { recursive: true });
    await mkdir(join(worktree, '.git'), { recursive: true });
    await writeFile(join(worktree, '.git', 'config'), '[core]\n');
    await writeFile(join(worktree, 'src.txt'), 'a\n');
    await beginTurnSnapshot(worktree, 'sess_b', { waitCapMs: 30_000 });
    await writeFile(join(worktree, 'node_modules', 'dep.js'), 'ignored\n');
    await writeFile(join(worktree, '.git', 'config'), '[core]\nchanged\n');
    await writeFile(join(worktree, 'src.txt'), 'a\nb\n');
    const diff = await getTurnReviewDiff(worktree, 'sess_b');
    assert.deepEqual(diff.files.map((file) => file.name), ['src.txt']);
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test('a session without a base reports empty and unsupported paths stay quiet', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'mixdog-turn-snapshot-nb-'));
  try {
    const diff = await getTurnReviewDiff(worktree, 'sess_never_began');
    assert.equal(diff.supported, true);
    assert.deepEqual(diff.files, []);
    assert.equal(diff.reason, 'no-base');
    const none = await getTurnReviewDiff('', 'sess_never_began');
    assert.equal(none.supported, false);
  } finally {
    await rm(worktree, { recursive: true, force: true });
    _resetTurnSnapshotForTest();
  }
});
