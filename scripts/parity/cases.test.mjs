import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCase, loadCases } from './cases.mjs';

function run({ op, args }) {
  switch (op) {
    case 'add': return args[0] + args[1];
    case 'upper': return args[0].toUpperCase();
    case 'join': return args[0].join(args[1]);
    case 'pair': return { [args[0]]: args[1] };
    default: throw new Error(`unknown op ${op}`);
  }
}

test('sample cases load and pass', () => {
  const cases = loadCases('sample');
  assert.deepEqual(cases.map((c) => c.id), ['add-small', 'upper-ascii', 'join-list', 'empty-join', 'object-result']);
  for (const c of cases) assertCase(c, run(c.input), 'sample');
});

test('a mismatch names the case id', () => {
  const [first] = loadCases('sample');
  assert.throws(() => assertCase(first, 4, 'sample'), (error) => error.name === 'AssertionError' && error.message.includes('case add-small'));
});

test('bad names and missing files are rejected', () => {
  assert.throws(() => loadCases('../sample'), /invalid case file name/);
  assert.throws(() => loadCases('no-such-file'), /ENOENT/);
});
