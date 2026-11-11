// readJsonFilePiecesSync reads what JSON.parse of the whole file reads — the
// same value, the same key order, the same refusals — however the file falls
// into blocks and however deep the pieces are cut.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readJsonFilePiecesSync } from './json-pieces-read.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-json-pieces-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function fileOf(text) {
  const file = join(dir, `f${(n += 1)}.json`);
  writeFileSync(file, text, 'utf8');
  return file;
}

const VALID = [
  '{}',
  '[]',
  ' \n{"a":1,"b":[1,2,{"c":"x\\"]}[,"}],"d":{"e":{"f":[true,false,null,-1.5e3]}}}\r\n',
  '{"nodes":[{"s":"héllo \u2026 \ud83d\ude00"},{"s":"a\\\\"},[],{}],"v":2,"meta":{"k":"v"}}',
  '[[1,[2,[3,[4]]]],"\\u2026",{"x":[]}]',
  '{"a":1,"a":2,"__proto__":{"polluted":true},"1":"x","0":"y"}',
  '"just a string"',
  '12.5',
  'null',
  '{"emptyKey":{"":""},"deep":{"a":{"b":{"c":{}}}}}',
];

test('equals JSON.parse of the whole text for every depth and block size', () => {
  for (const text of VALID) {
    const expected = JSON.parse(text);
    const file = fileOf(text);
    for (const pieceDepth of [0, 1, 2, 3, 9]) {
      for (const chunkBytes of [1, 2, 3, 5, 64, 1 << 20]) {
        const { value, chars } = readJsonFilePiecesSync(file, { pieceDepth, chunkBytes });
        assert.equal(JSON.stringify(value), JSON.stringify(expected), `${text} depth ${pieceDepth} block ${chunkBytes}`);
        assert.deepEqual(value, expected);
        assert.equal(chars, text.length);
      }
    }
  }
  const { value } = readJsonFilePiecesSync(fileOf(VALID[5]));
  assert.equal(Object.getPrototypeOf(value), Object.prototype, '"__proto__" stays an own member');
  assert.deepEqual(Object.keys(value), Object.keys(JSON.parse(VALID[5])));
});

test('refuses what JSON.parse refuses', () => {
  const invalid = [
    '',
    '   ',
    '\ufeff{}',
    '{"a":1,}',
    '[1,2,]',
    '[,1]',
    '{"a" 1}',
    '{"a":1 "b":2}',
    '{1:2}',
    '{"a":1}}',
    '{"a":1} x',
    '{"a":[1,2}',
    '{"a":{"b":1]}',
    '{"a":tru}',
    '[1 2]',
    '{"a":1',
    '{"a":"unterminated}',
    '[',
    ']',
    '{"a":}',
    '{"a"}',
  ];
  for (const text of invalid) {
    assert.throws(() => JSON.parse(text), SyntaxError, `JSON.parse accepts ${JSON.stringify(text)}`);
    for (const chunkBytes of [1, 4, 1 << 20]) {
      assert.throws(
        () => readJsonFilePiecesSync(fileOf(text), { pieceDepth: 2, chunkBytes }),
        SyntaxError,
        `${JSON.stringify(text)} block ${chunkBytes}`
      );
    }
  }
});
