import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANES, commandOf, selectedTests } from './k1-lanes.mjs';

// Runs `cargo test -- --list`, so it compiles each lane's test binaries (set CARGO_TARGET_DIR to reuse a build).
test('every lane filter selects at least one test', { timeout: 3_600_000 }, () => {
  for (const [name, lane] of Object.entries(LANES)) {
    for (const filter of lane.filters.length ? lane.filters : [null]) {
      assert.ok(selectedTests(name, filter).length > 0, `${name}: filter ${filter ?? '(all)'} selects no test`);
    }
  }
});

test('a filter that matches nothing selects nothing', { timeout: 3_600_000 }, () => {
  assert.deepEqual(selectedTests('advisory-lock', 'no_such_test_name_anywhere'), []);
});

test('a lane is one cargo run per filter on its package', () => {
  assert.deepEqual(commandOf('advisory-lock', 'cargo nextest run', 'x'), { program: 'cargo', args: ['nextest', 'run', '-p', 'mixdog-tools', '--locked', 'x'] });
  assert.deepEqual(commandOf('provider-contract').args, ['test', '-p', 'mixdog-ai', '--locked']);
});
