import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BACKEND_INSTALLERS, LANES, commandOf, installersIn, runChild, selectedTests } from './k1-lanes.mjs';

// Runs `cargo test -- --list`, so it compiles each lane's test binaries (set CARGO_TARGET_DIR to reuse a build).
test('every lane filter selects at least one test', { timeout: 3_600_000 }, async () => {
  for (const [name, lane] of Object.entries(LANES)) {
    for (const filter of lane.filters.length ? lane.filters : [null]) {
      assert.ok((await selectedTests(name, filter)).length > 0, `${name}: filter ${filter ?? '(all)'} selects no test`);
    }
  }
});

test('a filter that matches nothing selects nothing', { timeout: 3_600_000 }, async () => {
  assert.deepEqual(await selectedTests('advisory-lock', 'no_such_test_name_anywhere'), []);
});

test('a lane is one cargo run per filter on its package', () => {
  assert.deepEqual(commandOf('advisory-lock', 'cargo nextest run', 'x'), { program: 'cargo', args: ['nextest', 'run', '-p', 'mixdog-tools', '--locked', 'x'] });
  assert.deepEqual(commandOf('provider-contract').args, ['test', '-p', 'mixdog-ai', '--locked']);
});

// The command line itself: the patch-release job runs `k1-lanes.mjs patch-bytes`, which once ran every lane.
const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./k1-lanes.mjs', import.meta.url)), '--dry-run', ...args], { encoding: 'utf8', timeout: 60_000 });
// `filter(Boolean)` drops only the empty line after the last newline; the Set folds a lane's several filters (one output line each) into the lane.
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

test('a lane step that does not finish names its lane and filter, preflight listing included', async () => {
  await assert.rejects(selectedTests('compact', 'compact_fresh', { deadlineMs: 1 }), /lane compact \(filter compact_fresh, preflight listing\) did not finish within 1ms and was ended/);
  await assert.rejects(runChild('cargo', ['--version'], { label: 'lane compact (filter compact_fresh)', deadlineMs: 1 }), /lane compact \(filter compact_fresh\) did not finish within 1ms and was ended/);
});

test('the cargo children skip the user-data backup guard', async () => {
  const done = await runChild('node', ['-e', 'console.log(process.env.MIXDOG_SKIP_USER_DATA_BACKUP)'], { deadlineMs: 30_000 });
  assert.equal(done.stdout.trim(), '1');
});
test('lanes are validated before --list runs: an unknown lane fails there too', () => {
  const run = cli('--list', 'no-such-lane');
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unknown lane no-such-lane/);
  assert.equal(spawnSync(process.execPath, [fileURLToPath(new URL('./k1-lanes.mjs', import.meta.url)), '--list', 'compact'], { encoding: 'utf8', timeout: 60_000 }).status, 0);
});

test('a lane is a property of the table, not of Object.prototype', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    for (const mode of [['--list'], ['--dry-run'], []]) {
      const run = cli(...mode, name);
      assert.notEqual(run.status, 0, `${mode} ${name} should fail`);
      assert.match(run.stderr, new RegExp(`unknown lane ${name}`));
    }
  }
});

// Tests that install an executor backend of their own only pass in a process each (AlreadyInstalled otherwise).
test('BACKEND_INSTALLERS names every test file that installs a backend', () => {
  const production = new Set(['native/core/crates/mixdog-app-server-daemon/src/lib.rs', 'native/core/crates/mixdog-cli/src/main.rs']);
  const found = spawnSync('git', ['grep', '-l', '-E', 'mixdog_rt::install\\(|exec::boot\\(|boot_executors\\(\\)', '--', 'native/core/crates'], { cwd: join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'), encoding: 'utf8', timeout: 60_000 });
  assert.equal(found.status, 0, found.stderr);
  const files = found.stdout.split(/\r?\n/).filter(Boolean).filter((file) => !production.has(file)).sort();
  assert.deepEqual(files, Object.keys(BACKEND_INSTALLERS).sort());
});

test('no lane filter selects a backend-installing test', { timeout: 3_600_000 }, async () => {
  for (const [name, lane] of Object.entries(LANES)) {
    for (const filter of lane.filters.length ? lane.filters : [null]) {
      assert.deepEqual(installersIn(await selectedTests(name, filter)), [], `lane ${name} filter ${filter ?? '(all)'}`);
    }
  }
});

test('the installing tests are recognised by their module path', () => {
  assert.deepEqual(installersIn(['bot_routes_never_ran::a_bot_route_read', 'run_host::request_snapshot::x', 'tidy::process::map_limit']), ['bot_routes_never_ran::a_bot_route_read', 'tidy::process::map_limit']);
});
