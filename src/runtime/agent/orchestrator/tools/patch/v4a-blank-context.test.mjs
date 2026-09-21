// Blank lines inside a V4A update section. A blank line reaches the parser as
// an empty raw line: inside an open hunk it is a single-space context line,
// before any hunk it is envelope whitespace and opens nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseV4APatch } from './parsing.mjs';

test('a blank line inside an open update hunk becomes a context line', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: a.txt',
    '@@ anchor',
    ' first',
    '',
    ' second',
    '-drop me',
    '+keep me',
    '*** End Patch',
    '',
  ].join('\n');
  const files = parseV4APatch(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].hunks.length, 1);
  assert.deepEqual(files[0].hunks[0].lines, [' first', ' ', ' second', '-drop me', '+keep me']);
});

test('a blank line before any hunk opens no hunk', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: a.txt',
    '',
    '@@ anchor',
    ' first',
    '-drop me',
    '+keep me',
    '*** End Patch',
    '',
  ].join('\n');
  const files = parseV4APatch(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].hunks.length, 1);
  assert.deepEqual(files[0].hunks[0].lines, [' first', '-drop me', '+keep me']);
});
