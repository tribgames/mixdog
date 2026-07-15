import assert from 'node:assert/strict';
import test from 'node:test';
import { actionableFailureCount } from './smoke-loop-failure-summary.mjs';

test('returns a numeric actionable failure count', () => {
  assert.equal(actionableFailureCount('{"actionable_failures":{"matched":0}}'), 0);
  assert.equal(actionableFailureCount('{"actionable_failures":{"matched":1}}'), 1);
});

test('rejects malformed tool-failures JSON', () => {
  assert.throws(
    () => actionableFailureCount('{'),
    /tool failures returned malformed JSON/,
  );
});

test('rejects a missing or malformed actionable failure count', () => {
  assert.throws(
    () => actionableFailureCount('{}'),
    /tool failures returned malformed result schema/,
  );
  assert.throws(
    () => actionableFailureCount('{"actionable_failures":{"matched":"0"}}'),
    /tool failures returned malformed result schema/,
  );
  assert.throws(
    () => actionableFailureCount('{"actionable_failures":{"matched":-1}}'),
    /tool failures returned malformed result schema/,
  );
  assert.throws(
    () => actionableFailureCount('{"actionable_failures":{"matched":0.5}}'),
    /tool failures returned malformed result schema/,
  );
  assert.throws(
    () => actionableFailureCount('{"actionable_failures":{"matched":1e999}}'),
    /tool failures returned malformed result schema/,
  );
});
