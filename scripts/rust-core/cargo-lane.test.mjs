import assert from 'node:assert/strict';
import test from 'node:test';

import { runLane, selectedTests } from './cargo-lane.mjs';

const quiet = { log: { log() {}, error() {} } };

test('libtest listings are reduced to test names', () => {
  assert.deepEqual(selectedTests('a::b: test\nc::d: bench\n\n2 tests, 0 benchmarks\n'), ['a::b']);
});

test('every filter runs once, with the package and --locked', () => {
  const ran = [];
  const code = runLane('mixdog-tools', ['one', 'two'], {
    ...quiet,
    list: () => ({ status: 0, stdout: 'x::y: test\n' }),
    run: (args) => (ran.push(args), { status: 0 }),
  });
  assert.equal(code, 0);
  assert.deepEqual(ran, [
    ['test', '-p', 'mixdog-tools', '--locked', 'one'],
    ['test', '-p', 'mixdog-tools', '--locked', 'two'],
  ]);
});

test('no filter runs the whole package', () => {
  const ran = [];
  runLane('mixdog-ai', [], { ...quiet, list: () => ({ status: 0, stdout: 'a: test\n' }), run: (args) => (ran.push(args), { status: 0 }) });
  assert.deepEqual(ran, [['test', '-p', 'mixdog-ai', '--locked']]);
});

test('a filter that selects no test fails the lane before anything runs', () => {
  const code = runLane('mixdog-tools', ['missing'], {
    ...quiet,
    list: () => ({ status: 0, stdout: '\n0 tests, 0 benchmarks\n' }),
    run: () => assert.fail('ran a lane with no tests'),
  });
  assert.equal(code, 1);
});

test('a failing test stops the lane with its exit code', () => {
  const ran = [];
  const code = runLane('p', ['a', 'b'], {
    ...quiet,
    list: () => ({ status: 0, stdout: 'a: test\n' }),
    run: (args) => (ran.push(args), { status: 101 }),
  });
  assert.equal(code, 101);
  assert.equal(ran.length, 1);
});