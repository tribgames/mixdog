import test from 'node:test';
import assert from 'node:assert/strict';
import { contextPctDisplayLabel } from './statusline.mjs';

test('contextPctDisplayLabel clamps displayed percent at 100', () => {
  assert.equal(contextPctDisplayLabel(105), '100');
  assert.equal(contextPctDisplayLabel(100.9), '100');
  assert.equal(contextPctDisplayLabel(99.2), '99');
});

test('contextPctDisplayLabel keeps sub-1% decimal display', () => {
  assert.equal(contextPctDisplayLabel(0.45), '0.5');
  assert.equal(contextPctDisplayLabel(0.04), '0');
});

