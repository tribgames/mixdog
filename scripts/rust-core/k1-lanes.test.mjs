import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BACKEND_INSTALLERS, LANES, commandOf, installersIn, isInstalledBy, parseArgs, testBinariesOf, testsOfList } from './k1-lanes.mjs';

// The pure parts of the lane runner. Whether a lane filter still selects a test is decided from the compiled test list, not
// here: scripts/ci/check-lane-filters.mjs, run by release-gate.yml `core-tests` over the archive core-build makes.

test('every lane names a package and a list of filters, and a filter is a plain substring (no pattern characters)', () => {
  for (const [name, lane] of Object.entries(LANES)) {
    assert.match(lane.pkg, /^mixdog-[a-z-]+$/, name);
    assert.ok(Array.isArray(lane.filters), name);
    assert.equal(typeof lane.replaces, 'string', name);
    for (const filter of lane.filters) assert.match(filter, /^[A-Za-z0-9_:]+$/, `${name}: ${filter}`);
  }
});

test('commands name the lane package and one filter, and the command line parses', () => {
  assert.deepEqual(commandOf('compact', 'cargo test', 'compact_fresh'), { program: 'cargo', args: ['test', '-p', 'mixdog-agent', '--locked', 'compact_fresh'] });
  assert.deepEqual(commandOf('provider-contract'), { program: 'cargo', args: ['test', '-p', 'mixdog-ai', '--locked'] });
  assert.deepEqual(parseArgs(['--dry-run', 'compact']), { runner: 'cargo test', list: false, dryRun: true, names: ['compact'] });
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('libtest listings drop the #[ignore]d tests the run skips', () => {
  const list = 'a::one: test\na::two: test\nb::three: test\n\n3 tests, 0 benchmarks\n';
  const ignored = 'a::two: test\n';
  assert.deepEqual(testsOfList(list, ignored, '/x/src/lib.rs').map((entry) => entry.name), ['a::one', 'b::three']);
});

test('only compiler artifacts that are test binaries are taken from a build', () => {
  const lines = [
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable: '/t/a', target: { name: 'a' } }),
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: false }, executable: '/t/b' }),
    JSON.stringify({ reason: 'build-finished' }),
    'not json',
  ].join('\n');
  assert.deepEqual(testBinariesOf(lines).map((binary) => binary.executable), ['/t/a']);
});

test('a test of an executor-backend installer is recognised by the binary that holds it', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  // a standalone test binary (its crate root is the file) is installed wholly
  const ticker = 'native/core/crates/mixdog-rt/tests/ticker.rs';
  assert.ok(BACKEND_INSTALLERS.includes(ticker));
  assert.ok(isInstalledBy(ticker, { name: 'any', srcPath: join(root, ticker) }));
  // a binary that gathers modules holds it as the module the file names
  const gathered = 'native/core/crates/mixdog-mcp/tests/it/skill_catalog_suite.rs';
  const main = join(root, 'native/core/crates/mixdog-mcp/tests/it/main.rs');
  assert.ok(isInstalledBy(gathered, { name: 'skill_catalog_suite::a', srcPath: main }));
  assert.ok(!isInstalledBy(gathered, { name: 'other::a', srcPath: main }));
  assert.equal(installersIn([{ name: 'other::a', srcPath: main }]).length, 0);
});
