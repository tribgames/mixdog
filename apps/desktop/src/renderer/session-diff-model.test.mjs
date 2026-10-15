import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSessionDiffRows,
  sessionDiffFilePatch,
  sessionDiffPatchTooLarge,
  utf8ByteLength,
} from './session-diff-model.ts';
import { boundReviewPatch } from '../../../../src/runtime/shared/review-diff.mjs';

test('utf8ByteLength matches TextEncoder, surrogate pairs and lone surrogates included', () => {
  const encoder = new TextEncoder();
  for (const text of ['', 'ascii', 'é', '한글', '😀x', '\ud800', 'a\udc00b', `${'한'.repeat(10)}😀é`]) {
    assert.equal(utf8ByteLength(text), encoder.encode(text).length, JSON.stringify(text));
  }
});

test('a `+++`/`---`-prefixed changed line inside a hunk is held to the 1 MiB line limit; file headers are not', () => {
  const head = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n';
  const long = 'x'.repeat(1024 * 1024 + 1);
  assert.equal(sessionDiffPatchTooLarge(`${head}-old\n+++${long}\n`), true, 'an added line beginning with "++"');
  assert.equal(sessionDiffPatchTooLarge(`${head}---${long}\n+new\n`), true, 'a deleted line beginning with "--"');
  // A second file section's headers are headers again (before its own first @@).
  const second = `diff --git a/${long} b/y.txt\n--- a/${long}\n+++ b/y.txt\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.equal(sessionDiffPatchTooLarge(`${head}-old\n+new\n${second}`), false);
  // Under the line limit in UTF-16 units, over it in UTF-8 bytes.
  assert.equal(sessionDiffPatchTooLarge(`${head}-old\n+++${'한'.repeat(400_000)}\n`), true);
});

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

test('a file slice holds only its own parts, and an empty patch or blank path yields nothing', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-one',
    '+two',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '-three',
    '+four',
    '',
  ].join('\n');
  const slice = sessionDiffFilePatch(patch, 'b.txt');
  assert.match(slice, /\+four/);
  assert.doesNotMatch(slice, /\+two/);
  assert.equal(sessionDiffFilePatch('', 'b.txt'), '');
  assert.equal(sessionDiffFilePatch(patch, ''), '');
  assert.equal(sessionDiffFilePatch(patch, 'missing.txt'), '');
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

test('two roots showing the same relative name stay two rows, each with its own diff', () => {
  const patch = (name, line) =>
    `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${line}\n`;
  const first = 'C:/work/a/x.txt';
  const second = 'C:/work/b/x.txt';
  const rows = buildSessionDiffRows({
    supported: true,
    patch: patch(first, 'one') + patch(second, 'two'),
    files: [
      { id: first, path: first, outside: false, status: 'A', additions: 1, deletions: 0 },
      { id: second, path: second, outside: false, status: 'A', additions: 1, deletions: 0 },
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    [first, second]
  );
  assert.deepEqual(
    rows.map((row) => row.parts.length),
    [1, 1]
  );
  assert.ok(rows[0].parts[0].patch.includes('+one') && !rows[0].parts[0].patch.includes('+two'));
  assert.ok(rows[1].parts[0].patch.includes('+two'));
  // The runtime's flag, not the absolute spelling, decides "outside project".
  assert.deepEqual(
    rows.map((row) => row.outside),
    [false, false]
  );
  const legacy = buildSessionDiffRows({ files: [{ path: 'C:/o/y.txt' }, { path: 'src/z.ts' }] });
  assert.deepEqual(
    legacy.map((row) => row.outside),
    [true, false]
  );
  // Same id twice is one row.
  assert.equal(
    buildSessionDiffRows({
      files: [
        { id: 'k', path: 'a' },
        { id: 'k', path: 'a' },
      ],
    }).length,
    1
  );
});

test('a per-turn fallback response with two roots lists two rows, each selectable with its own diff', () => {
  const a = 'C:/tmp/fallback-a/x.txt';
  const b = 'C:/tmp/fallback-b/x.txt';
  const section = (name, line) =>
    `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${line}\n`;
  const rows = buildSessionDiffRows({
    supported: true,
    patch: section(a, 'one') + section(b, 'two'),
    files: [
      { path: a, id: a, outside: false, status: 'A', additions: 1, deletions: 0 },
      { path: b, id: b, outside: false, status: 'A', additions: 1, deletions: 0 },
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.path),
    [a, b]
  );
  // No phantom relative `x.txt` row, and every listed row has a diff to show.
  assert.ok(rows.every((row) => row.parts.length === 1));
  const picked = rows.find((row) => row.path === b);
  assert.ok(picked.parts[0].patch.includes('+two') && !picked.parts[0].patch.includes('+one'));
});

test('a real a/ or b/ directory is not the git header prefix: a/x.ts, b/x.ts and x.ts stay separate rows', () => {
  const patch = (name, line) =>
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+${line}\n`;
  const names = ['a/x.ts', 'b/x.ts', 'x.ts'];
  const result = {
    supported: true,
    files: names.map((path) => ({ path, status: 'M' })),
    patch: names.map((name) => patch(name, `in-${name.replace('/', '-')}`)).join(''),
  };
  const rows = buildSessionDiffRows(result);
  assert.deepEqual(
    rows.map((row) => row.path),
    names
  );
  rows.forEach((row, index) => {
    assert.equal(row.parts.length, 1);
    assert.match(row.parts[0].patch, new RegExp(`\\+in-${names[index].replace('/', '-')}\\b`));
    assert.equal(row.additions, 1);
  });
  assert.match(sessionDiffFilePatch(result.patch, 'b/x.ts'), /\+in-b-x\.ts/);
  assert.doesNotMatch(sessionDiffFilePatch(result.patch, 'x.ts'), /in-b-x|in-a-x/);
});
