import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSelectedStagePatch,
  createDiffSnapshot,
  deleteDiffSnapshot,
  diffSnapshotMatches,
  getDiffSnapshot,
} from './git-partial-stage.mjs';

const plan = { cwd: process.cwd(), globalArgs: [], args: ['--', 'a.txt'] };
const snapshotOf = (raw) =>
  createDiffSnapshot({
    repo: process.cwd(),
    scope: process.cwd(),
    plan,
    argv: ['diff', '--', 'a.txt'],
    raw,
  });

test('snapshot retains its path scope and rejects content or index hash changes', () => {
  const raw = 'diff --git a/a.txt b/a.txt\nindex 123..456 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new \n';
  const { diffId } = snapshotOf(raw);
  const snapshot = getDiffSnapshot(diffId);
  assert.deepEqual(snapshot.plan.args, ['--', 'a.txt']);
  assert.deepEqual(snapshot.argv, ['diff', '--', 'a.txt']);
  assert.equal(diffSnapshotMatches(snapshot, raw), true);
  assert.equal(diffSnapshotMatches(snapshot, raw.replace('123..456', '789..456')), false);
  assert.equal(diffSnapshotMatches(snapshot, raw.replace('+new ', '+new')), false);
  snapshot.plan.args.push('other.txt');
  assert.deepEqual(getDiffSnapshot(diffId).plan.args, ['--', 'a.txt']);
  deleteDiffSnapshot(diffId);
  assert.equal(getDiffSnapshot(diffId), null);
});

test('new files, empty files and no-newline patches stage as whole files without altering their patch', () => {
  const patches = [
    'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n',
    'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n',
    'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n\\ No newline at end of file\n',
    'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n',
  ];
  for (const raw of patches) {
    const { changes } = snapshotOf(raw);
    assert.equal(changes.length, 1);
    const built = buildSelectedStagePatch(raw, [changes[0].id]);
    assert.equal(built.patch, raw);
    assert.deepEqual(built.selected, [changes[0].id]);
    assert.deepEqual(built.missing, []);
    assert.deepEqual(built.changes, changes);
  }
});

test('file IDs identify quoted UTF-8 paths and allow selecting just one new file', () => {
  const first =
    'diff --git "a/\\303\\251.txt" "b/\\303\\251.txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/\\303\\251.txt"\n@@ -0,0 +1 @@\n+one\n';
  const second =
    'diff --git a/two.txt b/two.txt\nnew file mode 100644\n--- /dev/null\n+++ b/two.txt\n@@ -0,0 +1 @@\n+two\n';
  const raw = first + second;
  const { changes } = snapshotOf(raw);
  assert.deepEqual(
    changes.map(({ path }) => path),
    ['é.txt', 'two.txt']
  );
  assert.equal(buildSelectedStagePatch(raw, [changes[0].id]).patch, first);
  assert.equal(buildSelectedStagePatch(raw, [changes[1].id]).patch, second);
  assert.deepEqual(buildSelectedStagePatch(raw, ['c99']).missing, ['c99']);
  assert.deepEqual(buildSelectedStagePatch(raw, ['chg_0123456789abcdef']).missing, ['chg_0123456789abcdef']);
});

test('change ids are ordinals in diff order, shared across files and stable for the same diff', () => {
  const raw =
    'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+A\n@@ -9 +9 @@\n-z\n+Z\n' +
    'diff --git a/mode.txt b/mode.txt\nold mode 100644\nnew mode 100755\n' +
    'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,3 +1,3 @@\n-x\n+X\n y\n-z\n+Z\n';
  const first = snapshotOf(raw);
  assert.deepEqual(
    first.changes.map(({ id, path }) => [id, path]),
    [
      ['c1', 'a.txt'],
      ['c2', 'a.txt'],
      ['c3', 'mode.txt'],
      ['c4', 'b.txt'],
      ['c5', 'b.txt'],
    ]
  );
  // Distinct snapshots of the same diff number identically; the diff_id is the scope.
  const second = snapshotOf(raw);
  assert.notEqual(first.diffId, second.diffId);
  assert.deepEqual(
    second.changes.map(({ id }) => id),
    ['c1', 'c2', 'c3', 'c4', 'c5']
  );
  assert.equal(
    buildSelectedStagePatch(raw, ['c5']).patch,
    'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,3 +1,3 @@\n x\n y\n-z\n+Z\n'
  );
  assert.deepEqual(buildSelectedStagePatch(raw, ['c2', 'c3']).selected, ['c2', 'c3']);
});

test('zero-context insertion groups and ordinary edit groups remain independently selectable', () => {
  const raw =
    'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+inserted\n@@ -3 +4 @@\n-old\n+new\n';
  const { changes } = snapshotOf(raw);
  assert.equal(changes.length, 2);
  assert.equal(
    buildSelectedStagePatch(raw, [changes[0].id]).patch,
    'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+inserted\n'
  );
  assert.equal(
    buildSelectedStagePatch(raw, [changes[1].id]).patch,
    'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -3 +3 @@\n-old\n+new\n'
  );
});
