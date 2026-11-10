import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runTree } from './lib/process-tree.mjs';
import { BACKEND_INSTALLERS, LANES, commandOf, installersIn, runChild, selectedTests, testBinariesOf, testsOfList } from './k1-lanes.mjs';

test('a lane is one cargo run per filter on its package', () => {
  assert.deepEqual(commandOf('advisory-lock', 'cargo nextest run', 'x'), { program: 'cargo', args: ['nextest', 'run', '-p', 'mixdog-tools', '--locked', 'x'] });
  assert.deepEqual(commandOf('provider-contract').args, ['test', '-p', 'mixdog-ai', '--locked']);
});

// The command line itself: the patch-release job runs `k1-lanes.mjs patch-bytes`, which once ran every lane.
const LANES_CLI = fileURLToPath(new URL('./k1-lanes.mjs', import.meta.url));
const runCli = (...args) => runTree(process.execPath, [LANES_CLI, ...args], { label: `k1-lanes `, deadlineMs: 60_000 });
const cli = (...args) => runCli('--dry-run', ...args);
// `filter(Boolean)` drops only the empty line after the last newline; the Set folds a lane's several filters (one output line each) into the lane.
const lanesOf = (stdout) => [...new Set(stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t')[0]))];

test('a named lane runs that lane only, whatever its position and with or without --runner', async () => {
  assert.deepEqual(lanesOf((await cli('patch-bytes')).stdout), ['patch-bytes']);
  assert.deepEqual(lanesOf((await cli('compact', 'patch-bytes')).stdout), ['compact', 'patch-bytes']);
  assert.deepEqual(lanesOf((await cli('--runner', 'cargo nextest run', 'compact')).stdout), ['compact']);
  assert.deepEqual(lanesOf((await cli('compact', '--runner', 'cargo nextest run', 'patch-bytes')).stdout), ['compact', 'patch-bytes']);
  assert.match((await cli('--runner', 'cargo nextest run', 'compact')).stdout, /\tcargo nextest run -p mixdog-agent --locked compact_fresh\n/);
});

test('no lane named runs every lane, and an unknown lane or option fails', async () => {
  assert.deepEqual(lanesOf((await cli()).stdout), Object.keys(LANES));
  const unknown = (await cli('no-such-lane'));
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown lane no-such-lane/);
  assert.notEqual((await cli('--bogus')).status, 0);
  assert.notEqual((await cli('--runner')).status, 0);
});

test('a lane step that does not finish names its lane and filter, preflight listing included', async () => {
  await assert.rejects(selectedTests('compact', 'compact_fresh', { deadlineMs: 1 }), /lane compact \(filter compact_fresh, preflight listing\) build did not finish within 1ms and was ended/);
  await assert.rejects(runChild('cargo', ['--version'], { label: 'lane compact (filter compact_fresh)', deadlineMs: 1 }), /lane compact \(filter compact_fresh\) did not finish within 1ms and was ended/);
});

test('the cargo children skip the user-data backup guard', async () => {
  const done = await runChild('node', ['-e', 'console.log(process.env.MIXDOG_SKIP_USER_DATA_BACKUP)'], { deadlineMs: 30_000 });
  assert.equal(done.stdout.trim(), '1');
});
test('a lane is a property of the table, not of Object.prototype', async () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    for (const mode of [['--list'], ['--dry-run'], []]) {
      const run = (await cli(...mode, name));
      assert.notEqual(run.status, 0, `${mode} ${name} should fail`);
      assert.match(run.stderr, new RegExp(`unknown lane ${name}`));
    }
  }
});

// Tests that install an executor backend of their own only pass in a process each (AlreadyInstalled otherwise).
test('BACKEND_INSTALLERS names every test file that installs a backend', async () => {
  const production = new Set(['native/core/crates/mixdog-app-server-daemon/src/lib.rs', 'native/core/crates/mixdog-cli/src/main.rs']);
  const found = await runTree('git', ['grep', '-l', '-E', 'mixdog_rt::install\\(|exec::boot\\(|boot_executors\\(\\)', '--', 'native/core/crates'], { label: 'git grep of the backend installers', cwd: join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'), deadlineMs: 60_000 });
  assert.equal(found.status, 0, found.stderr);
  const files = found.stdout.split(/\r?\n/).filter(Boolean).filter((file) => !production.has(file)).sort();
  assert.deepEqual(files, [...BACKEND_INSTALLERS].sort());
});

const at = (path) => resolve(fileURLToPath(new URL('../..', import.meta.url)), path);

test('an installer is recognised by the binary its test is in, not by a name prefix', () => {
  // A standalone integration-test binary: its tests carry no file name (tests/ticker.rs -> `a_tick`).
  const ticker = at('native/core/crates/mixdog-rt/tests/ticker.rs');
  assert.equal(installersIn([{ name: 'a_tick', srcPath: ticker }]).length, 1);
  // The same test name in another binary is not the installer.
  assert.equal(installersIn([{ name: 'a_tick', srcPath: at('native/core/crates/mixdog-rt/tests/other.rs') }]).length, 0);
  // A binary gathering modules (tests/it/main.rs): only the installer's module counts; the victims next to it do not.
  const it = at('native/core/crates/mixdog-core/tests/it/main.rs');
  assert.equal(installersIn([{ name: 'bot_routes_never_ran::a_bot_route_read', srcPath: it }]).length, 1);
  assert.equal(installersIn([{ name: 'mcp_seams::a_seam', srcPath: it }, { name: 'script_syntax::x', srcPath: it }]).length, 0);
  // A module of a library's unit tests (src/tidy/process.rs).
  const lib = at('native/core/crates/mixdog-services/src/lib.rs');
  assert.equal(installersIn([{ name: 'tidy::process::map_limit', srcPath: lib }, { name: 'tidy::other::x', srcPath: lib }]).length, 1);
});

// Recorded from cargo for the mixdog-tools package (`cargo test -p mixdog-tools --no-run --message-format=json`, then the
// test binary's `--list fs::tests`): the selection logic runs on this without a build. k1-lanes.integration.test.mjs runs
// the same steps for real.
const recorded = (name) => readFileSync(new URL(`./recorded/${name}`, import.meta.url), 'utf8');

test('the test binaries are the compiler artifacts that are test targets with an executable', () => {
  const noise = [JSON.stringify({ reason: 'build-finished', success: true }), JSON.stringify({ reason: 'compiler-artifact', profile: { test: false }, executable: 'x' }), 'warning: not json'];
  const binaries = testBinariesOf(`${recorded('lanes_build_messages.jsonl')}${noise.join('\n')}\n`);
  assert.ok(binaries.length > 0);
  assert.ok(binaries.every((binary) => binary.profile.test && binary.executable && binary.target.src_path));
});

test('only the lines libtest lists as tests are tests, and each carries its binary', () => {
  const { mixdog_tools: listed } = JSON.parse(recorded('lanes_list_fs_tests.json'));
  const tests = testsOfList(`${listed.list}3 tests, 0 benchmarks\n`, 'src/lib.rs');
  assert.ok(tests.length > 10);
  assert.ok(tests.every((t) => t.name.startsWith('fs::tests::') && t.srcPath === 'src/lib.rs'));
  assert.deepEqual(testsOfList('a: test\nb: benchmark\n\n', 'x'), [{ name: 'a', srcPath: 'x' }]);
});

test('no recorded fs::tests test of the patch-bytes lane is a backend installer', () => {
  const { mixdog_tools: listed } = JSON.parse(recorded('lanes_list_fs_tests.json'));
  assert.deepEqual(installersIn(testsOfList(listed.list, at('native/core/crates/mixdog-tools/src/lib.rs'))), []);
});