import assert from 'node:assert/strict';
import test from 'node:test';
import { _cloneJson } from './openai-ws-delta.mjs';
import { shareJsonStrings } from '../../../shared/json-snapshot.mjs';

test('WebSocket snapshots preserve JSON normalization for every supported value shape', () => {
  const sparse = new Array(4);
  sparse[1] = undefined;
  sparse[3] = '한글\ud800\0🙂';
  for (const value of [
    'long immutable text '.repeat(1_000),
    0,
    -0,
    NaN,
    Infinity,
    false,
    sparse,
    new Date('2026-01-01T00:00:00.000Z'),
    new Number(NaN),
    new String('boxed'),
    Object.assign(Object.create(null), { message: 'text', omitted: undefined }),
    JSON.parse('{"__proto__":{"safe":true},"constructor":"ordinary data"}'),
    {
      toJSON(key) {
        return { key, output: 'custom serialization' };
      },
    },
    { text: 'kept', omit: undefined, fn() {}, [Symbol('ignored')]: 'ignored' },
  ]) {
    const expected = JSON.parse(JSON.stringify(value));
    assert.deepEqual(_cloneJson(value), expected);
  }
});

test('snapshot objects and arrays stay isolated from the source and from repeated references', () => {
  const text = 'message with opaque replay data '.repeat(1000);
  const child = { content: [{ type: 'input_text', text }], arguments: '{"x":"unchanged"}' };
  const input = [child, child];
  const snapshot = _cloneJson(input);
  assert.deepEqual(snapshot, input);
  assert.notEqual(snapshot, input);
  assert.notEqual(snapshot[0], snapshot[1]);
  assert.notEqual(snapshot[0].content, child.content);
  child.content[0].text = 'mutated source';
  assert.equal(snapshot[0].content[0].text, text);
  snapshot[0].content[0].text = 'mutated snapshot';
  assert.equal(snapshot[1].content[0].text, text);
});

test('snapshot serialization observes getters and toJSON exactly as JSON.stringify does', () => {
  const fixture = () => {
    const calls = [];
    const value = {
      get text() {
        calls.push('text');
        return 'value';
      },
      child: {
        toJSON(key) {
          calls.push(`json:${key}`);
          return { text: 'child' };
        },
      },
    };
    return { calls, value };
  };
  const baseline = fixture();
  const expected = JSON.parse(JSON.stringify(baseline.value));
  const actual = fixture();
  assert.deepEqual(_cloneJson(actual.value), expected);
  assert.deepEqual(actual.calls, baseline.calls);
});

test('unsupported snapshots keep the existing fallback and parsed sharing never merges containers', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [cyclic, { value: 1n }, 1n, undefined, null, Symbol('value'), () => 'value']) {
    assert.equal(_cloneJson(value), value);
  }
  const value = JSON.parse('{"a":{"text":"same"},"b":{"text":"same"},"__proto__":"same"}');
  assert.equal(shareJsonStrings(value), value);
  assert.notEqual(value.a, value.b);
  value.a.text = 'changed';
  assert.equal(value.b.text, 'same');
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, '__proto__'), true);
});
