import assert from 'node:assert/strict';
import test from 'node:test';

import { jsonByteLength } from './json-byte-length.mjs';

const expected = (value) => {
  const json = JSON.stringify(value);
  return json === undefined ? undefined : Buffer.byteLength(json, 'utf8');
};

class Point {
  constructor() {
    this.x = 1;
    this.y = [2, undefined];
  }
}

const VALUES = [
  null,
  undefined,
  true,
  false,
  0,
  -0,
  1.5e-7,
  1e21,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  '',
  'plain ascii',
  'quote " backslash \\ slash /',
  'controls \b\f\n\r\t \u0000 \u0001 \u001f \u007f',
  'latin é ß, 한국어 세션, emoji 😀👍🏽, 𠜎',
  'lone \ud800 high, lone \udfff low, pair \ud83d\ude00, reversed \ude00\ud83d, end \ud800',
  '\u2028\u2029',
  [],
  [undefined, () => 1, Symbol('s'), null, 'x'],
  {},
  { a: undefined, b: () => 1, c: Symbol('s'), d: 1 },
  { 2: 'two', 1: 'one', b: 'b', a: 'a' },
  { nested: { deep: [{ key: 'value', n: [1, 2, { m: null }] }] } },
  Object.assign(Object.create(null), { bare: 1 }),
  { when: new Date(0) },
  { custom: { toJSON: (key) => `key:${key}` } },
  [{ toJSON: (key) => ({ index: key }) }],
  { map: new Map([[1, 2]]), set: new Set([1]), point: new Point() },
  { boxed: [new Number(3), new String('s'), new Boolean(false)] },
  { toJSONUndefined: { toJSON: () => undefined }, kept: 1 },
  new Date(86_400_000),
  { toJSON: () => 'top' },
];

test('jsonByteLength equals the UTF-8 length of JSON.stringify', () => {
  for (const value of VALUES) {
    assert.equal(jsonByteLength(value), expected(value), JSON.stringify(value) ?? String(value));
  }
});

test('jsonByteLength passes the member key to toJSON like JSON.stringify does', () => {
  const value = { toJSON: (key) => `k=${key}` };
  // '[' + seven '0,' elements, then the eighth element, then ']'.
  const inArray = JSON.stringify([0, 0, 0, 0, 0, 0, 0, value]).slice(15, -1);
  assert.equal(inArray, '"k=7"');
  assert.equal(jsonByteLength(value, 7), Buffer.byteLength(inArray));
});

test('jsonByteLength throws where JSON.stringify throws', () => {
  const cyclic = { name: 'loop' };
  cyclic.self = { back: cyclic };
  assert.throws(() => JSON.stringify(cyclic), TypeError);
  assert.throws(() => jsonByteLength(cyclic), TypeError);
  assert.throws(() => jsonByteLength({ big: 1n }), TypeError);
  // A shared (not cyclic) reference is fine.
  const shared = { s: 1 };
  assert.equal(jsonByteLength({ a: shared, b: [shared, shared] }), expected({ a: shared, b: [shared, shared] }));
});
