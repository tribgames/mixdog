import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { runTree } from './lib/process-tree.mjs';
import { BACKEND_INSTALLERS, BACKEND_PROCESS_ENTRIES, LANES, commandOf, installersIn, runChild, selectedTests, testBinariesOf, testsOfList } from './k1-lanes.mjs';

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

test('MIXDOG_CARGO is the command a lane runs for cargo (the build gate locally), plain cargo without it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k1-cargo-'));
  const fake = join(dir, 'fake-cargo.mjs');
  writeFileSync(fake, "console.log('via-gate ' + process.argv.slice(2).join(' '));\n");
  const saved = process.env.MIXDOG_CARGO;
  process.env.MIXDOG_CARGO = `"${process.execPath}" "${fake}"`;
  try {
    const done = await runChild('cargo', ['test', '--no-run'], { deadlineMs: 30_000 });
    assert.equal(done.stdout.trim(), 'via-gate test --no-run', done.stderr);
  } finally {
    if (saved === undefined) delete process.env.MIXDOG_CARGO;
    else process.env.MIXDOG_CARGO = saved;
    rmSync(dir, { recursive: true, force: true });
  }
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
  const processEntries = new Set(BACKEND_PROCESS_ENTRIES);
  const found = await runTree('git', ['grep', '-l', '-E', 'mixdog_rt::install\\(|exec::boot\\(|boot_executors\\(\\)', '--', 'native/core/crates'], { label: 'git grep of the backend installers', cwd: join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'), deadlineMs: 60_000 });
  assert.equal(found.status, 0, found.stderr);
  const captured = found.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(processEntries.size, BACKEND_PROCESS_ENTRIES.length, 'process entry paths are distinct');
  for (const file of processEntries) {
    assert.ok(captured.includes(file), `${file}: declared process entry no longer installs a backend`);
    assert.ok(!BACKEND_INSTALLERS.includes(file), `${file}: cannot be both a process entry and an installing test`);
  }
  const files = captured.filter((file) => !processEntries.has(file) && !file.includes('/examples/')).sort(); // an example is no test binary: no lane filter selects it
  assert.deepEqual(files, [...BACKEND_INSTALLERS].sort());
});

const at = (path) => resolve(fileURLToPath(new URL('../..', import.meta.url)), path);

test('new process entries install only in their declared entry, and helper entries have standalone callers', () => {
  const declarations = [
    ['native/core/crates/mixdog-cli/src/exec/mod.rs', 'pub fn run_command('],
    ['native/core/crates/mixdog-exthost-worker/src/methods/document_engine.rs', 'fn lanes('],
    ['native/core/crates/mixdog-office-com/src/host/mod.rs', 'pub fn run_with('],
    ['native/core/crates/mixdog-relay/src/server/mod.rs', 'pub fn run_cli('],
    ['native/core/crates/mixdog-relay/src/server/twin.rs', 'pub fn main('],
  ];
  const install = /mixdog_rt::install\(|exec::boot\(|boot_executors\(\)/g;
  for (const [file, entry] of declarations) {
    assert.ok(BACKEND_PROCESS_ENTRIES.includes(file));
    const source = readFileSync(at(file), 'utf8');
    const start = source.indexOf(entry);
    assert.ok(start >= 0, `${file}: missing entry ${entry}`);
    const end = source.indexOf('\n}', start);
    assert.ok(end > start, `${file}: entry has no closing brace`);
    const calls = [...source.matchAll(install)];
    assert.equal(calls.length, 1, `${file}: a new installer requires explicit production/test classification`);
    assert.ok(calls[0].index > start && calls[0].index < end, `${file}: installer escaped its declared process entry`);
  }
  const document = readFileSync(at(declarations[1][0]), 'utf8');
  assert.match(document, /#\[cfg\(not\(feature = "test-support"\)\)\]\s*fn lanes\(/);
  assert.match(document, /#\[cfg\(feature = "test-support"\)\]\s*fn lanes\([^]*?mixdog_rt::testing::tokens\(\)/);
  assert.match(readFileSync(at('native/core/crates/mixdog-office-com/tests/bin/office_com_host_test.rs'), 'utf8'), /fn main\([^]*?mixdog_office_com::host::run_with\(/);
  assert.match(readFileSync(at('native/core/crates/mixdog-relay/src/bin/relay_twin_host.rs'), 'utf8'), /fn main\([^]*?mixdog_relay::server::twin::main\(\)/);
});

test('an installer is recognised by the binary its test is in, not by a name prefix', () => {
  // A standalone integration-test binary: its tests carry no file name (tests/ticker.rs -> `a_tick`).
  const ticker = at('native/core/crates/mixdog-rt/tests/ticker.rs');
  assert.equal(installersIn([{ name: 'a_tick', srcPath: ticker }]).length, 1);
  // The same test name in another binary is not the installer.
  assert.equal(installersIn([{ name: 'a_tick', srcPath: at('native/core/crates/mixdog-rt/tests/other.rs') }]).length, 0);
  const mcpShape = 'a_tools_list_without_a_tools_array_is_treated_as_node_does';
  assert.equal(installersIn([{ name: mcpShape, srcPath: at('native/core/crates/mixdog-mcp/tests/mcp_list_shape.rs') }]).length, 1);
  assert.equal(installersIn([{ name: mcpShape, srcPath: at('native/core/crates/mixdog-mcp/tests/other.rs') }]).length, 0);
  // A binary gathering modules (tests/it/main.rs): only the installer's module counts; the victims next to it do not.
  const it = at('native/core/crates/mixdog-app-server-daemon/tests/it/main.rs');
  assert.equal(installersIn([{ name: 'real_executors::a_real_run', srcPath: it }]).length, 1);
  assert.equal(installersIn([{ name: 'mcp_seams::a_seam', srcPath: it }, { name: 'script_syntax::x', srcPath: it }]).length, 0);
  // A module of a library's unit tests (src/tidy/process.rs).
  const lib = at('native/core/crates/mixdog-services/src/lib.rs');
  assert.equal(installersIn([{ name: 'tidy::process::map_limit', srcPath: lib }, { name: 'tidy::other::x', srcPath: lib }]).length, 1);
});

// Recorded from cargo for the mixdog-tools package (`cargo test -p mixdog-tools --no-run --message-format=json`, then the
// test binary's `--list fs::tests`): the selection logic runs on this without a build. k1-lanes.slow.test.mjs runs
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
  const tests = testsOfList(`${listed.list}3 tests, 0 benchmarks\n`, '', 'src/lib.rs');
  assert.ok(tests.length > 10);
  assert.ok(tests.every((t) => t.name.startsWith('fs::tests::') && t.srcPath === 'src/lib.rs'));
  assert.deepEqual(testsOfList('a: test\nb: benchmark\n\n', '', 'x'), [{ name: 'a', srcPath: 'x' }]);
});

// libtest's `--list` names an `#[ignore]`d test like any other and the run then skips it; `--list --ignored` names only
// the ignored ones. A lane whose filter matches only ignored tests runs nothing, so it must select nothing.
test('an ignored test is not a selected one: a filter whose only match is ignored selects nothing', () => {
  const only = 'verdict::tag_gates::gate_5_live: test\n';
  assert.deepEqual(testsOfList(`${only}\n1 test, 0 benchmarks\n`, `${only}\n1 test, 0 benchmarks\n`, 'src/lib.rs'), []);
  assert.deepEqual(testsOfList(`a: test\n${only}`, only, 'src/lib.rs'), [{ name: 'a', srcPath: 'src/lib.rs' }]);
});

test('no recorded fs::tests test of the patch-bytes lane is a backend installer', () => {
  const { mixdog_tools: listed } = JSON.parse(recorded('lanes_list_fs_tests.json'));
  assert.deepEqual(installersIn(testsOfList(listed.list, '', at('native/core/crates/mixdog-tools/src/lib.rs'))), []);
});
