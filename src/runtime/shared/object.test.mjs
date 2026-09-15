import assert from 'node:assert/strict';
import test from 'node:test';

import { hasOwn, isPlainObject } from './object.mjs';

test('plain-object and own-property probes reject nullish and arrays', () => {
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(hasOwn(null, 'a'), false);
  assert.equal(hasOwn({ a: 1 }, 'a'), true);
  assert.equal(hasOwn(Object.create({ a: 1 }), 'a'), false);
});
