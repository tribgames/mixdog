import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSessionDiffRows, summarizeSessionTranscriptReview } from './turn-review-model.ts';

const patchFor = (file, added, removed) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${'-x\n'.repeat(removed)}${'+y\n'.repeat(added)}`;
const tool = (id, file, extra = {}) => ({
  kind: 'tool',
  id,
  name: 'apply_patch',
  args: { patch: patchFor(file, 2, 1) },
  result: 'ok',
  ...extra,
});

test('session transcript summary accumulates edits across turns and ignores failed ones', () => {
  const items = [
    { kind: 'user', id: 'u1', text: 'one' },
    tool('t1', 'a.txt'),
    { kind: 'turndone', id: 'd1' },
    { kind: 'user', id: 'u2', text: 'two' },
    tool('t2', 'b.txt'),
    tool('t3', 'c.txt', { isError: true }),
    { kind: 'turndone', id: 'd2' },
    { kind: 'user', id: 'u3', text: 'three' },
  ];
  const summary = summarizeSessionTranscriptReview(items);
  assert.deepEqual([...summary.files.keys()].sort(), ['a.txt', 'b.txt']);
  assert.equal(summary.additions, 4);
  assert.equal(summary.deletions, 2);
  assert.equal(summary.hasLineStats, true);
});

test('session transcript summary is empty without successful patch tools', () => {
  const summary = summarizeSessionTranscriptReview([
    { kind: 'user', id: 'u1', text: 'hi' },
    tool('t1', 'a.txt', { isError: true }),
  ]);
  assert.equal(summary.files.size, 0);
  assert.equal(summary.hasLineStats, false);
});

test('edit-dialect calls count through their per-call uiDiff, with absolute paths made project-relative', () => {
  const edit = (id, file, uiDiff, extra = {}) => ({
    kind: 'tool',
    id,
    name: 'edit',
    args: { file_path: file, old_string: 'a', new_string: 'b' },
    result: 'ok',
    uiDiff,
    ...extra,
  });
  const summary = summarizeSessionTranscriptReview(
    [
      { kind: 'user', id: 'u1', text: 'one' },
      edit('e1', 'C:\\demo\\cart-service\\a.txt', patchFor('C:/demo/cart-service/a.txt', 1, 0)),
      { kind: 'user', id: 'u2', text: 'two' },
      edit('e2', 'README.md', patchFor('README.md', 1, 0)),
      edit('e3', 'a.txt', patchFor('a.txt', 1, 0)),
      edit('e4', 'gone.txt', patchFor('gone.txt', 5, 0), { isError: true }),
      edit('e5', 'empty.txt', ''),
    ],
    'C:\\demo\\cart-service'
  );
  assert.deepEqual([...summary.files.keys()].sort(), ['README.md', 'a.txt']);
  assert.equal(summary.additions, 3);
});

test('grouped cards and write calls count across two turns', () => {
  const aggregate = (id, file, cat) => ({
    kind: 'tool',
    id,
    name: '__aggregate__',
    aggregate: true,
    args: { categoryOrder: [cat] },
    categories: { [cat]: { category: 'Patch', count: 1 } },
    result: '+1 line',
    uiDiff: patchFor(file, 1, 0),
    count: 1,
    errorCount: 0,
  });
  const summary = summarizeSessionTranscriptReview(
    [
      { kind: 'user', id: 'u1', text: 'create' },
      {
        kind: 'tool',
        id: 'w1',
        name: 'write',
        args: { file_path: 'C:\\demo\\cart-service\\new.txt', content: 'one\n' },
        result: 'Created C:\\demo\\cart-service\\new.txt (4 bytes)',
      },
      { kind: 'turndone', id: 'd1' },
      { kind: 'user', id: 'u2', text: 'edit' },
      aggregate('a1', 'README.md', 'Patch|Editing|Edited|file|files'),
      { kind: 'tool', id: 'w2', name: 'write', args: { file_path: 'bad.txt', content: 'x' }, result: 'Error', isError: true },
    ],
    'C:\\demo\\cart-service'
  );
  assert.deepEqual([...summary.files.keys()].sort(), ['README.md', 'new.txt']);
  assert.equal(summary.files.get('new.txt').status, 'A');
  assert.equal(summary.additions, 2);
});

test('three turns accumulate per file across aggregate cards', () => {
  const aggregate = (id, file, verb) => ({
    kind: 'tool',
    id,
    name: '__aggregate__',
    aggregate: true,
    args: {},
    categories: { [`Patch|${verb}|${verb}|file|files`]: { count: 1 } },
    result: '+1 line',
    uiDiff: patchFor(file, 1, 0),
    count: 1,
    errorCount: 0,
  });
  const items = [
    { kind: 'user', id: 'u1', text: 'create' },
    aggregate('a1', 'mx-island-check.txt', 'Creating'),
    { kind: 'turndone', id: 'd1' },
    { kind: 'user', id: 'u2', text: 'readme' },
    aggregate('a2', 'README.md', 'Editing'),
    { kind: 'turndone', id: 'd2' },
    { kind: 'user', id: 'u3', text: 'append' },
    aggregate('a3', 'mx-island-check.txt', 'Editing'),
  ];
  const transcript = summarizeSessionTranscriptReview(items, 'C:\\demo\\cart-service');
  assert.equal(transcript.files.get('mx-island-check.txt').additions, 2);
  assert.deepEqual([...transcript.files.keys()].sort(), ['README.md', 'mx-island-check.txt']);
  assert.equal(transcript.additions, 3);
});

test('session diff rows become a session summary', () => {
  const summary = summarizeSessionDiffRows([
    { path: 'a.txt', oldPath: '', status: 'M', additions: 3, deletions: 1, binary: false, parts: [] },
    { path: 'b.txt', oldPath: '', status: 'A', additions: 2, deletions: 0, binary: false, parts: [] },
  ]);
  assert.equal(summary.files.size, 2);
  assert.equal(summary.additions, 5);
  assert.equal(summary.deletions, 1);
});
