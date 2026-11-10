// The real build-and-list check of the lanes: every lane filter is run through cargo (`cargo test --no-run` for the
// package, then each test binary's `--list`), which compiles the lane's test binaries (~30 min cold, set CARGO_TARGET_DIR to
// reuse a build). It is an integration check, not a routine unit test: k1-lanes.test.mjs holds the lane-selection logic on
// recorded `--list` output. Run by the rust-core-lane-listing job of release-gate.yml (push and manual runs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runTree } from './lib/process-tree.mjs';
import { BACKEND_INSTALLERS, LANES, installersIn, isInstalledBy, selectedTests } from './k1-lanes.mjs';

const LANES_CLI = fileURLToPath(new URL('./k1-lanes.mjs', import.meta.url));
const runCli = (...args) => runTree(process.execPath, [LANES_CLI, ...args], { label: 'k1-lanes ', deadlineMs: 3_600_000 });
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


test('--list over a lane lists its tests and exits 0', { timeout: 3_600_000 }, async () => {
  assert.equal((await runCli('--list', 'compact')).status, 0);
});


test('no lane filter selects a backend-installing test', { timeout: 3_600_000 }, async () => {
  for (const [name, lane] of Object.entries(LANES)) {
    for (const filter of lane.filters.length ? lane.filters : [null]) {
      assert.deepEqual(installersIn(await selectedTests(name, filter)), [], `lane ${name} filter ${filter ?? '(all)'}`);
    }
  }
});


// Every installer file, through a real filter: list the package's tests, take one test of the installer by its binary, select
// exactly it with a filter, and require the lane check to see an installer. The unit test above cannot see what cargo lists.
const PACKAGE_OF = (file) => /crates\/([^/]+)\//.exec(file)[1];
for (const pkg of [...new Set(BACKEND_INSTALLERS.map(PACKAGE_OF))]) {
  test(`a filter selecting a test of each backend installer in ${pkg} is recognised`, { timeout: 3_600_000 }, async () => {
    const all = await selectedTests('compact', null, { pkg });
    for (const file of BACKEND_INSTALLERS.filter((f) => PACKAGE_OF(f) === pkg)) {
      const mine = all.filter((test) => isInstalledBy(file, test));
      assert.ok(mine.length > 0, `${file}: none of ${pkg}'s ${all.length} tests is in it`);
      const filtered = await selectedTests('compact', mine[0].name, { pkg });
      assert.ok(installersIn(filtered).some((test) => test.name === mine[0].name && test.srcPath === mine[0].srcPath), `${file}: the filter ${mine[0].name} did not select an installer`);
    }
  });
}