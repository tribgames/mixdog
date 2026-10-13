import assert from 'node:assert/strict';
import test from 'node:test';
import { callUiDiff } from './ui-diff.mjs';

test('callUiDiff keeps a normal edit diff', () => {
  const out = callUiDiff([{ displayPath: 'a.txt', before: 'x\ny\n', after: 'x\nz\n' }]);
  assert.match(out, /^@@/m);
  assert.match(out, /^-y$/m);
  assert.match(out, /^\+z$/m);
});

test('callUiDiff bounds a 6,000-line replacement and returns the cheap fallback', () => {
  const before = Array.from({ length: 6000 }, (_, i) => `old line ${i} ${'a'.repeat(8)}`).join('\n') + '\n';
  const after =
    Array.from({ length: 6000 }, (_, i) => `new line ${(i * 7919) % 6000} ${'b'.repeat(8)}`).join('\n') + '\n';
  const start = performance.now();
  const out = callUiDiff([{ displayPath: 'big.txt', before, after }]);
  const ms = performance.now() - start;
  assert.ok(ms < 1500, `took ${ms}ms`);
  assert.match(out, /^diff --git a\/big\.txt b\/big\.txt\n/);
  assert.match(out, /Binary files a\/big\.txt and b\/big\.txt differ/);
  assert.doesNotMatch(out, /^@@/m);
});
