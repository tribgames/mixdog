import assert from 'node:assert/strict';
import test from 'node:test';
import { callUiDiff, measureCallChanges } from './ui-diff.mjs';

test('NUL-containing UTF-8 is binary: no text hunks and no line counts', () => {
  const sides = [
    { before: 'a\nb\0c\n', after: 'a\nd\n' },
    { before: Buffer.from('a\n'), after: Buffer.from('a\0\nz\n') },
    { before: null, after: 'new\0file\n' },
  ];
  for (const { before, after } of sides) {
    const { diff, changes } = measureCallChanges([{ displayPath: 'blob.bin', before, after }]);
    assert.match(diff, /^Binary files (a\/blob\.bin|\/dev\/null) and b\/blob\.bin differ$/m);
    assert.doesNotMatch(diff, /^@@|\0/m);
    assert.equal(changes[0].additions, 0);
    assert.equal(changes[0].deletions, 0);
  }
});

test('callUiDiff keeps a normal edit diff', () => {
  const out = callUiDiff([{ displayPath: 'a.txt', before: 'x\ny\n', after: 'x\nz\n' }]);
  assert.match(out, /^@@/m);
  assert.match(out, /^-y$/m);
  assert.match(out, /^\+z$/m);
});

test('callUiDiff bounds a 6,000-line replacement and returns one replacement hunk', () => {
  const before = Array.from({ length: 6000 }, (_, i) => `old line ${i} ${'a'.repeat(8)}`).join('\n') + '\n';
  const after =
    Array.from({ length: 6000 }, (_, i) => `new line ${(i * 7919) % 6000} ${'b'.repeat(8)}`).join('\n') + '\n';
  const start = performance.now();
  const out = callUiDiff([{ displayPath: 'big.txt', before, after }]);
  const ms = performance.now() - start;
  assert.ok(ms < 1500, `took ${ms}ms`);
  assert.match(
    out,
    /^diff --git a\/big\.txt b\/big\.txt\n--- a\/big\.txt\n\+\+\+ b\/big\.txt\n@@ -1,6000 \+1,6000 @@\n/
  );
  assert.equal(out.match(/^-old line/gm).length, 6000);
  assert.equal(out.match(/^\+new line/gm).length, 6000);
  assert.doesNotMatch(out, /Binary files/);
});

test('callUiDiff keeps the common prefix and suffix as context around a replacement hunk', () => {
  // Over the line limit: never Myers-diffed, so this is the fallback hunk.
  const lines = Array.from({ length: 20_010 }, (_, i) => `line ${i}`);
  const before = `${lines.join('\n')}\n`;
  const edited = [...lines];
  edited[100] = 'changed 100';
  edited[105] = 'changed 105';
  const after = `${edited.join('\n')}\nno newline`;
  const out = callUiDiff([{ displayPath: 'long.txt', before, after }]);
  const changedOnly = callUiDiff([{ displayPath: 'long.txt', before, after: `${edited.join('\n')}\n` }]);
  assert.equal(
    changedOnly,
    'diff --git a/long.txt b/long.txt\n--- a/long.txt\n+++ b/long.txt\n@@ -98,12 +98,12 @@\n line 97\n line 98\n line 99\n' +
      '-line 100\n-line 101\n-line 102\n-line 103\n-line 104\n-line 105\n' +
      '+changed 100\n+line 101\n+line 102\n+line 103\n+line 104\n+changed 105\n' +
      ' line 106\n line 107\n line 108\n'
  );
  assert.match(out, /^@@ -98,19913 \+98,19914 @@$/m);
  assert.match(out, /\n line 97\n line 98\n line 99\n-line 100\n/);
  assert.match(out, /\n-line 20009\n\+changed 100\n/);
  assert.ok(out.endsWith('\n+line 20009\n+no newline\n\\ No newline at end of file\n'));
});
