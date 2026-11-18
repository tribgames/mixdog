import assert from 'node:assert/strict';
import test from 'node:test';

import { checkLanes, runnableTestsByPackage } from './check-lane-filters.mjs';

// A nextest list as `cargo nextest list --message-format json` prints it: suites by binary id, each with its package and its
// testcases (name -> { ignored }).
const suite = (pkg, names, ignored = []) => ({
  'package-name': pkg,
  testcases: Object.fromEntries([...names.map((name) => [name, { ignored: false }]), ...ignored.map((name) => [name, { ignored: true }])]),
});
const list = {
  'rust-suites': {
    'mixdog-tools': suite('mixdog-tools', ['exec::direct::tests::runs_a_program', 'fs::tests::the_advisory_lock_waits']),
    'mixdog-agent::it': suite('mixdog-agent', ['compact_fresh::a_fresh_session', 'turns::one'], ['compact_commit::ignored_only']),
    'mixdog-agent': suite('mixdog-agent', ['lib_only::x']),
  },
};
const lanes = {
  direct: { pkg: 'mixdog-tools', filters: ['exec::direct::tests'] },
  fresh: { pkg: 'mixdog-agent', filters: ['compact_fresh', 'turns::'] },
  everything: { pkg: 'mixdog-tools', filters: [] },
};

test('a filter is a substring of the compiled name, over every binary of the package', () => {
  assert.deepEqual(checkLanes(list, { lanes }), []);
  // the lib binary of mixdog-agent and its `it` binary are one package: a name in either selects
  assert.deepEqual(checkLanes(list, { lanes: { x: { pkg: 'mixdog-agent', filters: ['lib_only'] } } }), []);
});

test('a filter that matches no name fails, an ignored-only match does not count, and a lane with no filter needs one test', () => {
  assert.deepEqual(checkLanes(list, { lanes: { gone: { pkg: 'mixdog-agent', filters: ['compact_handoff'] } } }), [
    'lane gone: filter compact_handoff selects no un-ignored test of mixdog-agent',
  ]);
  assert.deepEqual(checkLanes(list, { lanes: { only: { pkg: 'mixdog-agent', filters: ['compact_commit'] } } }), [
    'lane only: filter compact_commit selects no un-ignored test of mixdog-agent',
  ]);
  const empty = { 'rust-suites': { ...list['rust-suites'], 'mixdog-ai': suite('mixdog-ai', [], ['a']) } };
  assert.deepEqual(checkLanes(empty, { lanes: { all: { pkg: 'mixdog-ai', filters: [] } } }), ['lane all: filter (all) selects no un-ignored test of mixdog-ai']);
});

test('a package missing from the archive fails, unless a pull request archive is allowed to hold only some crates', () => {
  const missing = { m: { pkg: 'mixdog-core', filters: ['run_host'] } };
  assert.deepEqual(checkLanes(list, { lanes: missing }), ['lane m: package mixdog-core is not in the archive']);
  assert.deepEqual(checkLanes(list, { lanes: missing, allowMissingPackages: true }), []);
});

test('the filter is matched case-sensitively and as written, not as a pattern', () => {
  assert.equal(checkLanes(list, { lanes: { c: { pkg: 'mixdog-tools', filters: ['Exec::direct'] } } }).length, 1);
  assert.equal(checkLanes(list, { lanes: { c: { pkg: 'mixdog-tools', filters: ['exec::.*'] } } }).length, 1);
});

test('input that is not a nextest list or holds no test is an error, never a pass', () => {
  assert.throws(() => checkLanes({}), /no "rust-suites"/);
  assert.throws(() => checkLanes({ 'rust-suites': {} }), /holds no test/);
  assert.deepEqual([...runnableTestsByPackage(list).keys()].sort(), ['mixdog-agent', 'mixdog-tools']);
});
