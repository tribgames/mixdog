import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import test from 'node:test';

import { SYSTEMS, selectCore, TESTS_PER_LEG } from './core-select.mjs';

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
file(
  'native/core/crates/gamma/src/lib.rs',
  'const RULES: &str = include_str!("../../../../../src/defaults/rules.json");\n'
);
file('native/core/crates/delta/src/lib.rs', '#[tokio::test]\nasync fn d() {}\n');
file(
  'native/core/crates/delta/src/fixtures_tests.rs',
  'let dir = base.join("fixtures/delta-set");\n#[test]\nfn f() {}\n'
);
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

test("a crate's manifest is not a test-only file: it reaches the crates above", () => {
  assert.deepEqual(packages(select(['native/core/crates/beta/Cargo.toml'])), ['beta', 'gamma']);
});

test('shared fixtures and product inputs select all even when a literal reader is known', () => {
  for (const path of [
    `native/core/${'fixtures'}/delta-set/golden.json`,
    'benchmarks/recorded/wire.json',
    'src/defaults/rules.json',
  ])
    assert.equal(select([path]).core_scope, 'all');
});

test('a fixture or product file no crate names selects the whole workspace, never nothing', () => {
  for (const path of [
    `native/core/${'fixtures'}/orphan/x.json`,
    'src/unread/file.mjs',
    'packages/protocol/src/index.ts',
    'apps/relay/server.mjs',
  ]) {
    const result = select([path]);
    assert.equal(result.core_scope, 'all', path);
    assert.equal(result.core_archive_args, '--workspace');
    assert.equal(result.core_filter, 'all()');
    assert.equal(result.core_packages, '');
  }
});

test("the build's own inputs and the gate itself reach every crate", () => {
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
  for (const path of [
    'docs/internal/plan.md',
    'apps/desktop/src/renderer/app.tsx',
    '.github/workflows/mobile-ios.yml',
    'CHANGELOG.md',
    'removed-shared-input.json',
  ])
    assert.equal(select([path]).core_scope, 'all', path);
});

test('a manual run, a push to main and the release gate select every crate whatever changed', () => {
  const result = select([], { all: true });
  assert.equal(result.core_scope, 'all');
  assert.equal(result.core_tests, 3 + 2 + 1 + 1 + 1 + 0);
});

test("the standalone native tools are the core's crates of the same name", () => {
  const withSpawn = {
    packages: [...metadata.packages, crate('mixdog-spawn'), crate('user', ['mixdog-spawn'])],
  };
  file('native/core/crates/mixdog-spawn/src/lib.rs', '');
  file('native/core/crates/user/src/lib.rs', '');
  const result = selectCore({ root, changed: ['native/mixdog-spawn/src/lib.rs'], metadata: withSpawn });
  assert.deepEqual(packages(result), ['mixdog-spawn', 'user']);
  assert.equal(
    selectCore({ root, changed: ['native/mixdog-spawn/tests/atomic_job.rs'], metadata: withSpawn }).core_scope,
    'all'
  );
});

test("the relay's test-support feature is named only when the relay is built", () => {
  const withRelay = { packages: [...metadata.packages, crate('mixdog-relay')] };
  file('native/core/crates/mixdog-relay/src/lib.rs', '');
  assert.equal(
    selectCore({ root, changed: ['native/core/crates/mixdog-relay/src/lib.rs'], metadata: withRelay }).core_features,
    'mixdog-relay/test-support'
  );
  assert.equal(
    selectCore({ root, changed: ['native/core/crates/delta/src/lib.rs'], metadata: withRelay }).core_features,
    ''
  );
  assert.equal(
    selectCore({ root, changed: [], all: true, metadata: withRelay }).core_features,
    'mixdog-relay/test-support'
  );
});

const legsOf = (result) =>
  Object.fromEntries(
    SYSTEMS.map((system) => [
      system.os,
      JSON.parse(result[`test_matrix_${system.os}`]).include.map((leg) => `${leg.os}:${leg.part}/${leg.of}`),
    ])
  );

test('every system the product ships on gets its own test matrix with as many legs as the tests need', () => {
  const small = select(['native/core/crates/delta/src/lib.rs']);
  assert.equal(small.core_build, true);
  assert.deepEqual(legsOf(small), { linux: ['linux:1/1'], macos: ['macos:1/1'], windows: ['windows:1/1'] });

  // Enough tests for three legs, and for more than the most a run has: macOS stops at three.
  file('native/core/crates/delta/src/many.rs', tests(TESTS_PER_LEG * 2 + 1));
  assert.equal(legsOf(select(['native/core/crates/delta/src/lib.rs'])).windows.length, 3);
  file('native/core/crates/delta/src/more.rs', tests(TESTS_PER_LEG * 5));
  const big = legsOf(select(['native/core/crates/delta/src/lib.rs']));
  assert.deepEqual(big.linux, ['linux:1/4', 'linux:2/4', 'linux:3/4', 'linux:4/4']);
  assert.deepEqual(big.macos, ['macos:1/3', 'macos:2/3', 'macos:3/3']);
  assert.equal(big.windows.length, 4);
  rmSync(join(root, 'native/core/crates/delta/src/many.rs'));
  rmSync(join(root, 'native/core/crates/delta/src/more.rs'));
});

const daemons = (result) => JSON.parse(result.mixdogd_matrix).include.map((entry) => entry.os);

test('an empty diff still builds the Linux daemon needed by desktop replay, and no archive', () => {
  const result = select([], { mixdogdDev: true });
  assert.equal(result.core, false);
  assert.equal(result.core_build, false);
  assert.deepEqual([result.mixdogd, daemons(result)], [true, ['linux']]);
  assert.deepEqual(legsOf(result), { linux: [], macos: [], windows: [] });
  assert.deepEqual([select([]).mixdogd, daemons(select([]))], [false, []]);
});

test('the Windows boot asks for the Windows dev daemon alone, beside the archive when there is one', () => {
  assert.deepEqual(daemons(select([], { mixdogdWindows: true })), ['windows']);
  const both = select(['native/core/crates/delta/src/lib.rs'], { mixdogdWindows: true });
  assert.equal(both.core_build, true);
  assert.deepEqual(daemons(both), ['windows']);
});

test('an archive with the entry tests selects core-entry and the Linux dev daemon without either slow Node lane', () => {
  file('native/core/crates/mixdog-entry/tests/node_free.rs', '#[test]\n#[ignore]\nfn entry() {}\n');
  const withEntry = { packages: [...metadata.packages, crate('mixdog-entry')] };
  const nextest = select(['.github/actions/install-nextest/action.yml', 'native/.config/nextest-standalone.toml'], {
    metadata: withEntry,
  });
  assert.deepEqual([nextest.core_entry, daemons(nextest)], [true, ['linux']]);
  // test legs alone need no daemon: the partitions depend on the archives only
  const other = select(['native/core/crates/delta/src/lib.rs'], { metadata: withEntry });
  assert.deepEqual([other.core, other.core_entry, daemons(other)], [true, false, []]);
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
  assert.deepEqual(packages(select(['native/core/crates/alpha/tests/deleted.rs'])), [
    'alpha',
    'beta',
    'delta',
    'gamma',
  ]);
});

test('gated target features and the real worker binary travel with the archive', () => {
  const worker = crate('mixdog-exthost-worker');
  worker.targets = [{ kind: ['bin'], 'required-features': ['test-support'] }];
  file('native/core/crates/mixdog-exthost-worker/src/lib.rs', '');
  const result = selectCore({
    root,
    changed: ['native/core/crates/gamma/src/lib.rs'],
    metadata: { packages: [...metadata.packages, worker] },
  });
  assert.ok(packages(result).includes('mixdog-exthost-worker'));
  assert.match(result.core_features, /mixdog-exthost-worker\/test-support/);
});

test('the Postgres-backed tests get a Linux leg per profile whose crate the archive holds, and one macOS job outside a pull request', () => {
  const withPg = (...names) => {
    for (const name of names) file(`native/core/crates/${name}/src/lib.rs`, tests(1));
    return { packages: [...metadata.packages, ...names.map((name) => crate(name))] };
  };
  const legs = (result) => JSON.parse(result.core_pg_matrix).include.map((leg) => `${leg.os}:${leg.profile}`);
  const macos = (result) => [result.core_pg_macos, JSON.parse(result.core_pg_macos_profiles)];
  const both = withPg('mixdog-services', 'mixdog-app-server-daemon');
  const all = selectCore({ root, changed: [], all: true, metadata: both });
  assert.equal(all.core_pg, true);
  assert.deepEqual(legs(all), ['linux:services-pg', 'linux:pg']);
  assert.deepEqual(macos(all), [true, ['services-pg', 'pg']]);
  // a pull request that changes the services crate: its profile on Linux; the daemon is not in the archive; no macOS job
  const services = selectCore({ root, changed: ['native/core/crates/mixdog-services/src/lib.rs'], metadata: both });
  assert.deepEqual(legs(services), ['linux:services-pg']);
  assert.deepEqual(macos(services), [false, []]);
  // a change elsewhere in the workspace selects neither crate: no Postgres job
  const other = select(['native/core/crates/delta/src/lib.rs']);
  assert.deepEqual([other.core_pg, other.core_pg_matrix], [false, '{"include":[]}']);
  assert.equal(selectCore({ root, changed: [], metadata: both }).core_pg, false);
});
