import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

// The command line itself: the patch-release job runs `k1-lanes.mjs patch-bytes`, which once ran every lane.
const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./k1-lanes.mjs', import.meta.url)), '--dry-run', ...args], { encoding: 'utf8' });
const lanesOf = (stdout) => [...new Set(stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t')[0]))];

test('a named lane runs that lane only, whatever its position and with or without --runner', () => {
  assert.deepEqual(lanesOf(cli('patch-bytes').stdout), ['patch-bytes']);
  assert.deepEqual(lanesOf(cli('compact', 'patch-bytes').stdout), ['compact', 'patch-bytes']);
  assert.deepEqual(lanesOf(cli('--runner', 'cargo nextest run', 'compact').stdout), ['compact']);
  assert.deepEqual(lanesOf(cli('compact', '--runner', 'cargo nextest run', 'patch-bytes').stdout), ['compact', 'patch-bytes']);
  assert.match(cli('--runner', 'cargo nextest run', 'compact').stdout, /\tcargo nextest run -p mixdog-agent --locked compact_fresh\n/);
});

test('no lane named runs every lane, and an unknown lane or option fails', () => {
  assert.deepEqual(lanesOf(cli().stdout), Object.keys(LANES));
  const unknown = cli('no-such-lane');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown lane no-such-lane/);
  assert.notEqual(cli('--bogus').status, 0);
  assert.notEqual(cli('--runner').status, 0);
});