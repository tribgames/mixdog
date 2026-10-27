import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch, formatPatch, structuredPatch } from 'diff';
import { _resetLineDiffCacheForTest, createLineDiffBudget, lineDiffHunks } from './bounded-line-diff.mjs';

const pairs = [
  ['a\nb\nc\n', 'a\nB\nc\n'],
  ['x\r\ny\r\n', 'x\r\nY\r\n'],
  ['tail', 'tail\nmore'],
  ['', 'new\n'],
  ['gone\n', ''],
  ['1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n', '1\n2\nthree\n4\n5\n6\n7\n8\n9\nten\n11\n12'],
];

const patchOf = (hunks) => formatPatch({ oldFileName: 'a', newFileName: 'b', oldHeader: '', newHeader: '', hunks });

test('within budget the hunks are jsdiff’s own', () => {
  _resetLineDiffCacheForTest();
  for (const [before, after] of pairs) {
    const result = lineDiffHunks(before, after, createLineDiffBudget());
    assert.equal(result.exact, true);
    assert.deepEqual(result.hunks, structuredPatch('', '', before, after, '', '', { context: 3 }).hunks);
  }
});

test('a spent budget gives one replacement hunk that applies exactly', () => {
  _resetLineDiffCacheForTest();
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 6;
  const text = (count) =>
    Array.from({ length: count }, () => ['a', 'b', 'c', 'a\r', '', 'd'][random()]).join('\n') +
    (random() > 2 ? '\n' : '');
  const cases = [...pairs];
  for (let index = 0; index < 200; index += 1) cases.push([text(random() * 3), text(random() * 3)]);
  for (const [before, after] of cases) {
    if (before === after) continue;
    const result = lineDiffHunks(before, after, createLineDiffBudget(0));
    assert.equal(result.exact, false);
    assert.equal(result.hunks.length, 1);
    const [hunk] = result.hunks;
    const context = hunk.lines.filter((line) => line.startsWith(' ')).length;
    const removed = hunk.lines.filter((line) => line.startsWith('-')).length;
    const added = hunk.lines.filter((line) => line.startsWith('+')).length;
    assert.equal(hunk.oldLines, context + removed);
    assert.equal(hunk.newLines, context + added);
    assert.equal(applyPatch(before, patchOf(result.hunks)), after, JSON.stringify([before, after]));
  }
});

test('the replacement hunk keeps three context lines around the changed span', () => {
  _resetLineDiffCacheForTest();
  const before = '1\n2\n3\n4\n5\n6\n7\n8\n';
  const after = '1\n2\n3\n4\nfive\n6\n7\n8\n';
  const { hunks } = lineDiffHunks(before, after, createLineDiffBudget(0));
  assert.deepEqual(hunks, [
    { oldStart: 2, oldLines: 7, newStart: 2, newLines: 7, lines: [' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8'] },
  ]);
});

test('a pair is diffed once; a fallback forced by a spent budget is not cached', () => {
  _resetLineDiffCacheForTest();
  const before = Buffer.from('a\nb\nc\nd\ne\nf\ng\nh\n');
  const after = Buffer.from('a\nB\nc\nd\ne\nf\nG\nh\n');
  const starved = lineDiffHunks(before.toString(), after.toString(), createLineDiffBudget(0), [before, after]);
  assert.equal(starved.exact, false);
  const exact = lineDiffHunks(before.toString(), after.toString(), createLineDiffBudget(), [before, after]);
  assert.equal(exact.exact, true);
  assert.equal(exact.hunks.length, 1);
  // Cached by content: the same pair (as bytes or text) needs no budget again.
  assert.equal(lineDiffHunks(before.toString(), after.toString(), createLineDiffBudget(0)), exact);
});
