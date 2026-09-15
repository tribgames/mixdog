import assert from 'node:assert/strict';
import test from 'node:test';

import { optionValue } from './cli-args.mjs';

test('optionValue reads --name=value flags and ignores unrelated argv', () => {
  const argv = ['node', 'script.mjs', '--label=baseline', '--timeout-ms=300000', '--require-pass'];
  assert.equal(optionValue('label', argv), 'baseline');
  assert.equal(optionValue('timeout-ms', argv), '300000');
  assert.equal(optionValue('output', argv), '');
  assert.equal(optionValue('require-pass', argv), '');
});

test('optionValue preserves empty assignments and the first matching flag', () => {
  assert.equal(optionValue('only', ['--only=', '--only=S01']), '');
  assert.equal(optionValue('only', ['--only=S01,S02', '--only=later']), 'S01,S02');
});
