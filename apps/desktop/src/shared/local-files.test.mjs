import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLocalFileLocation } from './local-files.ts';

test('supported location syntaxes keep their line and column', () => {
  const cases = [
    ['src/a.ts:12', { path: 'src/a.ts', line: 12 }],
    ['src/a.ts:12:4', { path: 'src/a.ts', line: 12, column: 4 }],
    ['src/a.ts:12-20', { path: 'src/a.ts', line: 12 }],
    ['src/a.ts#L12', { path: 'src/a.ts', line: 12 }],
    ['src/a.ts#L12-L20', { path: 'src/a.ts', line: 12 }],
    ['src/a.ts#L12C4', { path: 'src/a.ts', line: 12, column: 4 }],
    ['src/a.ts#L12C4-L12C9', { path: 'src/a.ts', line: 12, column: 4 }],
    ['src/a.ts#L7-L7', { path: 'src/a.ts', line: 7 }],
    ['C:/x/a.ts', { path: 'C:/x/a.ts' }],
    ['C:/x/a.ts:3', { path: 'C:/x/a.ts', line: 3 }],
  ];
  for (const [href, expected] of cases) assert.deepEqual(parseLocalFileLocation(href), expected, href);
});

test('reversed ranges and non-positive or unsafe numbers drop the suffix and open at the top', () => {
  for (const href of [
    'src/main.ts#L20-L10',
    'src/main.ts:20-10',
    'src/main.ts#L0',
    'src/main.ts:0',
    'src/main.ts:5:0',
    'src/main.ts#L5C0',
    'src/main.ts#L12C9-L12C4',
    'src/main.ts#L12C4-L20C0',
    'src/main.ts#L12C4-L20C9007199254740993',
    'src/main.ts:12:9-4',
    'src/main.ts:9007199254740993',
    'src/main.ts#L9007199254740993',
  ]) {
    assert.deepEqual(parseLocalFileLocation(href), { path: 'src/main.ts' }, href);
  }
});
