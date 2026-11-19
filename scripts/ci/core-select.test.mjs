import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import test from 'node:test';

import { MAX_LEGS, SYSTEMS, selectCore, TESTS_PER_LEG } from './core-select.mjs';

// A workspace of five crates on disk, in the shape `cargo metadata --no-deps` reports:
//   alpha <- beta <- gamma (each depends on the one before), delta alone, mixdog-workspace-hack beside them.
// delta's tests read fixtures/delta-set; gamma's library opens src/defaults/rules.json by path (include_str!); beta's tests open
// benchmarks/recorded/wire.json with joined segments.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-select-')));
test.after(() => {
  assert.equal(realpathSync(dirname(root)), realpathSync(tmpdir()));
  assert.equal(lstatSync(root).isSymbolicLink(), false);
  rmSync(root, { recursive: true, force: true });
});

function file(path, text) {
  const full = join(root, path);
  assert.ok(!relative(root, full).startsWith('..'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}
const tests = (n) => Array.from({ length: n }, (_, i) => `#[test]\nfn t${i}() {}\n`).join('');
const crate = (name, deps = []) => ({
  name,
  manifest_path: join(root, 'native/core/crates', name, 'Cargo.toml'),
  dependencies: deps.map((dep) => ({ name: dep })),
  targets: name === 'mixdog-relay' ? [{ kind: ['test'], 'required-features': ['test-support'] }] : [],
});
const metadata = {
  packages: [
    crate('alpha'),
    crate('beta', ['alpha']),
    crate('gamma', ['beta', 'serde']),
    crate('delta'),
    crate('mixdog-workspace-hack'),
  ],
};
file('native/core/crates/alpha/src/lib.rs', tests(3));
file('native/core/crates/alpha/tests/it.rs', tests(2));
file('native/core/crates/beta/src/lib.rs', tests(1));
file('native/core/crates/beta/tests/wire.rs', 'let p = root.join("benchmarks").join("recorded").join("wire.json");\n');
file('native/core/crates/gamma/src/lib.rs', 'const RULES: &str = include_str!("../../../../../src/defaults/rules.json");\n');
file('native/core/crates/delta/src/lib.rs', '#[tokio::test]\nasync fn d() {}\n');
file('native/core/crates/delta/src/fixtures_tests.rs', 'let dir = base.join("fixtures/delta-set");\n#[test]\nfn f() {}\n');
file('native/core/crates/mixdog-workspace-hack/src/lib.rs', '');

const select = (changed, extra = {}) => selectCore({ root, changed, metadata, ...extra });
const packages = (result) => result.core_packages.split(' ').filter(Boolean);

test('a changed library selects its crate and every crate that depends on it, through the chain', () => {
  const result = select(['native/core/crates/alpha/src/lib.rs']);
  assert.equal(result.core_scope, 'packages');
  assert.deepEqual(packages(result), ['alpha', 'beta', 'gamma']);
  assert.equal(result.core_archive_args, '-p alpha -p beta -p gamma');
  assert.equal(result.core_filter, 'package(=alpha) | package(=beta) | package(=gamma)');
});

test('a changed leaf crate selects only itself', () => {
  assert.deepEqual(packages(select(['native/core/crates/gamma/src/lib.rs'])), ['gamma']);
});

test('test changes propagate because a tests path is not exclusive ownership proof', () => {
  assert.deepEqual(packages(select(['native/core/crates/alpha/tests/it.rs'])), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(packages(select(['native/core/crates/delta/src/fixtures_tests.rs'])), ['delta']);
});

test('a crate\'s manifest is not a test-only file: it reaches the crates above', () => {
  assert.deepEqual(packages(select(['native/core/crates/beta/Cargo.toml'])), ['beta', 'gamma']);
});

test('shared fixtures and product inputs select all even when a literal reader is known', () => {
  for (const path of [`native/core/${'fixtures'}/delta-set/golden.json`, 'benchmarks/recorded/wire.json', 'src/defaults/rules.json'])
    assert.equal(select([path]).core_scope, 'all');
});

test('a fixture or product file no crate names selects the whole workspace, never nothing', () => {
  for (const path of [`native/core/${'fixtures'}/orphan/x.json`, 'src/unread/file.mjs', 'packages/protocol/src/index.ts', 'apps/relay/server.mjs']) {
    const result = select([path]);
    assert.equal(result.core_scope, 'all', path);
    assert.equal(result.core_archive_args, '--workspace');
    assert.equal(result.core_filter, 'all()');
    assert.equal(result.core_packages, '');
  }
});

test('the build\'s own inputs and the gate itself reach every crate', () => {
  for (const path of [
    'native/core/Cargo.lock',
    'native/core/Cargo.toml',
    'native/core/.config/nextest.toml',
    'native/core/.cargo/config.toml',
    'native/core/build-support/dev_only.rs',
    'native/core/crates/mixdog-workspace-hack/Cargo.toml',
    'rust-toolchain.toml',
    '.github/workflows/release-gate.yml',
    '.github/actions/install-nextest/action.yml',
    'scripts/ci/core-select.mjs',
  ]) {
    assert.equal(select([path]).core_scope, 'all', path);
  }
});

test('the standalone nextest config does not select workspace builds or tests', () => {
  const config = 'native/.config/nextest-standalone.toml';
  assert.equal(select([config]).core_build, false);
  assert.deepEqual(packages(select([config, 'native/core/crates/delta/src/lib.rs'])), ['delta']);
});

test('unowned and deleted inputs are conservatively whole-workspace until readers are proven', () => {
  for (const path of ['docs/internal/plan.md', 'apps/desktop/src/renderer/app.tsx', '.github/workflows/mobile-ios.yml', 'CHANGELOG.md', 'removed-shared-input.json'])
    assert.equal(select([path]).core_scope, 'all', path);
});

test('a manual run, a push to main and the release gate select every crate whatever changed', () => {
  const result = select([], { all: true });
  assert.equal(result.core_scope, 'all');
  assert.equal(result.core_tests, 3 + 2 + 1 + 1 + 1 + 0);
});

test('the standalone native tools are the core\'s crates of the same name', () => {
  const withSpawn = {
    packages: [...metadata.packages, crate('mixdog-spawn'), crate('user', ['mixdog-spawn'])],
  };
  file('native/core/crates/mixdog-spawn/src/lib.rs', '');
  file('native/core/crates/user/src/lib.rs', '');
  const result = selectCore({ root, changed: ['native/mixdog-spawn/src/lib.rs'], metadata: withSpawn });
  assert.deepEqual(packages(result), ['mixdog-spawn', 'user']);
  assert.equal(selectCore({ root, changed: ['native/mixdog-spawn/tests/atomic_job.rs'], metadata: withSpawn }).core_scope, 'all');
});

test('the relay\'s test-support feature is named only when the relay is built', () => {
  const withRelay = { packages: [...metadata.packages, crate('mixdog-relay')] };
  file('native/core/crates/mixdog-relay/src/lib.rs', '');
  assert.equal(selectCore({ root, changed: ['native/core/crates/mixdog-relay/src/lib.rs'], metadata: withRelay }).core_features, 'mixdog-relay/test-support');
  assert.equal(selectCore({ root, changed: ['native/core/crates/delta/src/lib.rs'], metadata: withRelay }).core_features, '');
  assert.equal(selectCore({ root, changed: [], all: true, metadata: withRelay }).core_features, 'mixdog-relay/test-support');
});

test('every system the product ships on gets a build and as many legs as the tests need', () => {
  const small = select(['native/core/crates/delta/src/lib.rs']);
  assert.equal(small.core_legs, 1);
  const build = JSON.parse(small.build_matrix).include;
  assert.deepEqual(build.map((entry) => entry.os), SYSTEMS.map((system) => system.os));
  assert.ok(build.every((entry) => entry.tests && !entry.mixdogd));
  const legs = JSON.parse(small.test_matrix).include;
  assert.equal(legs.length, SYSTEMS.length);
  assert.ok(legs.every((leg) => leg.part === 1 && leg.of === 1));

  // Enough tests for three legs, and for more than the most a run has.
  file('native/core/crates/delta/src/many.rs', tests(TESTS_PER_LEG * 2 + 1));
  assert.equal(select(['native/core/crates/delta/src/lib.rs']).core_legs, 3);
  file('native/core/crates/delta/src/more.rs', tests(TESTS_PER_LEG * 5));
  const big = select(['native/core/crates/delta/src/lib.rs']);
  assert.equal(big.core_legs, MAX_LEGS);
  const parts = JSON.parse(big.test_matrix).include.filter((leg) => leg.os === 'linux').map((leg) => `${leg.part}/${leg.of}`);
  assert.deepEqual(parts, ['1/4', '2/4', '3/4', '4/4']);
  rmSync(join(root, 'native/core/crates/delta/src/many.rs'));
  rmSync(join(root, 'native/core/crates/delta/src/more.rs'));
});

test('an empty diff still builds the Linux daemon needed by desktop replay', () => {
  const result = select([], { mixdogdDev: true });
  assert.equal(result.core, false);
  assert.deepEqual(JSON.parse(result.build_matrix).include.map((entry) => [entry.os, entry.tests, entry.mixdogd]), [['linux', false, true]]);
  assert.equal(JSON.parse(result.test_matrix).include.length, 0);
  const both = select(['native/core/crates/delta/src/lib.rs'], { mixdogdDev: true });
  assert.deepEqual(JSON.parse(both.build_matrix).include.map((entry) => [entry.os, entry.tests, entry.mixdogd]),
    [['linux', true, true], ['macos', true, false], ['windows', true, false]]);
});

test('the Windows boot asks for the Windows dev daemon alone, beside the archive when there is one', () => {
  const shape = (result) => JSON.parse(result.build_matrix).include.map((entry) => [entry.os, entry.tests, entry.mixdogd]);
  assert.deepEqual(shape(select([], { mixdogdWindows: true })), [['windows', false, true]]);
  assert.deepEqual(shape(select(['native/core/crates/delta/src/lib.rs'], { mixdogdWindows: true })),
    [['linux', true, false], ['macos', true, false], ['windows', true, true]]);
});

test('an archive with the entry tests requests the Linux dev daemon without either slow Node lane', () => {
  file('native/core/crates/mixdog-entry/tests/node_free.rs', '#[test]\n#[ignore]\nfn entry() {}\n');
  const withEntry = { packages: [...metadata.packages, crate('mixdog-entry')] };
  const legs = (changed) => JSON.parse(select(changed, { metadata: withEntry }).build_matrix).include;
  const nextest = legs(['.github/actions/install-nextest/action.yml', 'native/.config/nextest-standalone.toml']);
  assert.deepEqual(nextest.map(({ os, tests, mixdogd }) => [os, tests, mixdogd]),
    [['linux', true, true], ['macos', true, false], ['windows', true, false]]);
  assert.ok(legs(['native/core/crates/delta/src/lib.rs']).every((leg) => !leg.mixdogd));
});

test('the matrices are what the workflow reads: runner, nextest download name and executable suffix per system', () => {
  const [linux, macos, windows] = SYSTEMS;
  assert.deepEqual([linux.runner, linux.nextest, linux.exe], ['ubuntu-22.04', 'linux', '']);
  assert.deepEqual([macos.runner, macos.nextest, macos.exe], ['macos-15', 'mac', '']);
  assert.deepEqual([windows.runner, windows.nextest, windows.exe], ['windows-2022', 'windows-tar', '.exe']);
});

test('a crate that includes another crate test module is selected without a Cargo dependency', () => {
  file('native/core/crates/delta/src/shared.rs', '#[path = "../../alpha/tests/it.rs"] mod shared;');
  assert.deepEqual(packages(select(['native/core/crates/alpha/tests/it.rs'])), ['alpha', 'beta', 'delta', 'gamma']);
  assert.deepEqual(packages(select(['native/core/crates/alpha/tests/deleted.rs'])), ['alpha', 'beta', 'delta', 'gamma']);
});

test('gated target features and the real worker binary travel with the archive', () => {
  const worker = crate('mixdog-exthost-worker');
  worker.targets = [{ kind: ['bin'], 'required-features': ['test-support'] }];
  file('native/core/crates/mixdog-exthost-worker/src/lib.rs', '');
  const result = selectCore({ root, changed: ['native/core/crates/gamma/src/lib.rs'], metadata: { packages: [...metadata.packages, worker] } });
  assert.ok(packages(result).includes('mixdog-exthost-worker'));
  assert.match(result.core_features, /mixdog-exthost-worker\/test-support/);
});

test('the Postgres-backed tests get a leg per profile whose crate the archive holds, macOS only outside a pull request', () => {
  const withPg = (...names) => {
    for (const name of names) file(`native/core/crates/${name}/src/lib.rs`, tests(1));
    return { packages: [...metadata.packages, ...names.map((name) => crate(name))] };
  };
  const legs = (result) => JSON.parse(result.core_pg_matrix).include.map((leg) => `${leg.os}:${leg.profile}`);
  const both = withPg('mixdog-services', 'mixdog-app-server-daemon');
  const all = selectCore({ root, changed: [], all: true, metadata: both });
  assert.equal(all.core_pg, true);
  assert.deepEqual(legs(all), ['linux:services-pg', 'macos:services-pg', 'linux:pg', 'macos:pg']);
  // a pull request that changes the services crate: its profile on Linux; the daemon is not in the archive
  const services = selectCore({ root, changed: ['native/core/crates/mixdog-services/src/lib.rs'], metadata: both });
  assert.deepEqual(legs(services), ['linux:services-pg']);
  // a change elsewhere in the workspace selects neither crate: no Postgres job
  const other = select(['native/core/crates/delta/src/lib.rs']);
  assert.deepEqual([other.core_pg, other.core_pg_matrix], [false, '{"include":[]}']);
  assert.equal(selectCore({ root, changed: [], metadata: both }).core_pg, false);
});
