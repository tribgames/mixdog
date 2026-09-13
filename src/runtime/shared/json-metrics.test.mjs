import assert from 'node:assert/strict';
import test from 'node:test';
import { hashStructuredValue } from './json-metrics.mjs';

test('structured hashes cannot confuse string delimiters with array elements', () => {
  assert.notEqual(hashStructuredValue(['a', 'b']), hashStructuredValue(['a;s:b']));
});

test('structured hashes distinguish marker-like object keys and values', () => {
  const split = { a: 'v', b: 'w' };
  assert.notEqual(hashStructuredValue(split), hashStructuredValue({ a: 'v;k:b;s:w' }));
  assert.notEqual(hashStructuredValue(split), hashStructuredValue({ 'a;s:v;k:b': 'w' }));
});

test('structured hashes distinguish unpaired UTF-16 code units', () => {
  assert.notEqual(hashStructuredValue('\ud800'), hashStructuredValue('\ud801'));
});

test('deep structured payloads do not lose identity to a call-stack limit', () => {
  let first = 'first';
  let second = 'second';
  for (let i = 0; i < 20_000; i += 1) {
    first = [first];
    second = [second];
  }
  assert.notEqual(hashStructuredValue(first), hashStructuredValue(second));
});

test('string budgets retain prefix hashing and hash algorithm selection', () => {
  const first = hashStructuredValue(['abc', 'one'], { maxStringChars: 3 });
  const second = hashStructuredValue(['abc', 'two'], { maxStringChars: 3 });
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{40}$/);
  assert.match(hashStructuredValue({ ok: true }, { algorithm: 'sha256' }), /^[a-f0-9]{64}$/);
  assert.notEqual(hashStructuredValue(['abc', 'one']), hashStructuredValue(['abc', 'two']));
});

test('cycles terminate and repeated references are hashed by value', () => {
  const cycle = {};
  cycle.self = cycle;
  assert.equal(hashStructuredValue(cycle), hashStructuredValue(cycle));
  const value = { key: 'same' };
  assert.equal(hashStructuredValue([value, value]), hashStructuredValue([{ key: 'same' }, { key: 'same' }]));
});
