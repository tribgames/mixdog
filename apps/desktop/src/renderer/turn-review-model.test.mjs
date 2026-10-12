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

test('session diff rows become a session summary', () => {
  const summary = summarizeSessionDiffRows([
    { path: 'a.txt', oldPath: '', status: 'M', additions: 3, deletions: 1, binary: false, parts: [] },
    { path: 'b.txt', oldPath: '', status: 'A', additions: 2, deletions: 0, binary: false, parts: [] },
  ]);
  assert.equal(summary.files.size, 2);
  assert.equal(summary.additions, 5);
  assert.equal(summary.deletions, 1);
});
