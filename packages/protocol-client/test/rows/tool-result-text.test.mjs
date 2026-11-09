// The tool-result text helpers against what Node's own module (b6f10295a) answered for the same inputs
// (node-oracle/record.mjs): flattening, image parts, the recursion cap, the fallback truncation boundary.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as rows from '../../src/rows/tool-result-text.mjs';
import { TOOL_RESULT_TEXT } from './node-oracle/cases.mjs';

const golden = JSON.parse(readFileSync(new URL('./node-oracle/node-oracle.golden.json', import.meta.url), 'utf8'));

test('the golden is pinned to b6f10295a and covers every case', () => {
  assert.match(golden.recordedFrom, /^b6f10295a[0-9a-f]{31}$/);
  assert.equal(golden.text.length, TOOL_RESULT_TEXT.length);
});

TOOL_RESULT_TEXT.forEach(([fn, args], index) => {
  test(`${fn} equals Node's: case ${index} ${JSON.stringify(args).slice(0, 60)}`, () => {
    assert.deepEqual(golden.text[index].args, JSON.parse(JSON.stringify(args)));
    assert.deepEqual(rows[fn](...args) ?? null, golden.text[index].result);
  });
});
