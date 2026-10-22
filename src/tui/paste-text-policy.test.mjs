import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldFoldPastedText } from './paste-text-policy.mjs';

test('a paste folds only when longer than 1000 characters', () => {
  assert.equal(shouldFoldPastedText('x'.repeat(999)), false);
  assert.equal(shouldFoldPastedText('x'.repeat(1000)), false);
  assert.equal(shouldFoldPastedText('x'.repeat(1001)), true);
});

test('many short lines do not fold', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
  assert.equal(lines.length < 1000, true);
  assert.equal(shouldFoldPastedText(lines), false);
  assert.equal(shouldFoldPastedText(''), false);
});
