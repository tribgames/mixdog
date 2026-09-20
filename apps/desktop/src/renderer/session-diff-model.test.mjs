import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionDiffRows } from './session-diff-model.ts';
import { boundReviewPatch } from '../../../../src/runtime/shared/review-diff.mjs';

test('omitted large hunks keep modified, added and deleted rows in the session pane', () => {
  const patch = [
    `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+${'x'.repeat(70000)}\n`,
    'diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n',
    'diff --git a/c.txt b/c.txt\ndeleted file mode 100644\n--- a/c.txt\n+++ /dev/null\n',
  ].join('');
  const rows = buildSessionDiffRows({ supported: true, files: [], patch: boundReviewPatch(patch, 65536).patch });
  assert.deepEqual(
    rows.map((row) => [row.path, row.status]),
    [
      ['a.txt', 'M'],
      ['b.txt', 'A'],
      ['c.txt', 'D'],
    ]
  );
});

test('session diff rows follow the scoped capability file set', () => {
  const rows = buildSessionDiffRows({
    supported: true,
    files: [
      {
        path: 'src/owned.ts',
        status: 'M',
        additions: 1,
        deletions: 1,
      },
    ],
    patch: [
      'diff --git a/src/owned.ts b/src/owned.ts',
      '--- a/src/owned.ts',
      '+++ b/src/owned.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n'),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, 'src/owned.ts');
  assert.equal(rows[0].parts.length, 1);
  assert.equal(rows[0].additions, 1);
  assert.equal(rows[0].deletions, 1);
});

test('session diff rows still render an exact tracked patch without Git metadata', () => {
  const rows = buildSessionDiffRows({
    supported: true,
    files: [],
    patch: [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+session',
      '',
    ].join('\n'),
  });
  assert.deepEqual(
    rows.map((row) => ({
      path: row.path,
      additions: row.additions,
      deletions: row.deletions,
    })),
    [{ path: 'new.txt', additions: 1, deletions: 0 }]
  );
});
