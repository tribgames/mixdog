#!/usr/bin/env node
// `cargo test -p <pkg> <filter>` passes <filter> to each test binary of the package, and libtest, without --exact, runs the tests whose
// full name (module path + function, as `--list` prints it) CONTAINS <filter>, skipping `#[ignore]`d ones. nextest lists the same names,
// so a lane passes when some un-ignored testcase of package <pkg> has a key containing <filter> (no filter: any un-ignored testcase).
// Doc tests are not in the nextest list.
//
// Usage: node scripts/ci/check-lane-filters.mjs <nextest-list.json> [--allow-missing-packages]
//   (cargo nextest list --archive-file core-tests.tar.zst --workspace-remap native/core --message-format json > list.json)
// --allow-missing-packages skips a lane whose package is not in the archive (a pull request archives only changed crates); without it a
// missing package fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LANES } from '../rust-core/k1-lanes.mjs';

/** The un-ignored test names of each package in a nextest list: Map<package, string[]>. */
export function runnableTestsByPackage(list) {
  if (!list || typeof list !== 'object' || typeof list['rust-suites'] !== 'object')
    throw new Error('not a nextest list: no "rust-suites"');
  const byPackage = new Map();
  for (const [id, suite] of Object.entries(list['rust-suites'])) {
    const pkg = suite['package-name'] ?? id.split('::')[0];
    const names = Object.entries(suite.testcases ?? {})
      .filter(([, test]) => !test.ignored)
      .map(([name]) => name);
    byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), ...names]);
  }
  return byPackage;
}

/** The problems of `lanes` against a nextest list ([] when every lane filter selects a test that runs). */
export function checkLanes(list, { lanes = LANES, allowMissingPackages = false } = {}) {
  const tests = runnableTestsByPackage(list);
  if ([...tests.values()].every((names) => names.length === 0)) throw new Error('the nextest list holds no test');
  const problems = [];
  for (const [lane, { pkg, filters }] of Object.entries(lanes)) {
    if (!tests.has(pkg)) {
      if (!allowMissingPackages) problems.push(`lane ${lane}: package ${pkg} is not in the archive`);
      continue;
    }
    for (const filter of filters.length ? filters : [null]) {
      if (!tests.get(pkg).some((name) => filter === null || name.includes(filter))) {
        problems.push(`lane ${lane}: filter ${filter ?? '(all)'} selects no un-ignored test of ${pkg}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  const [file, ...flags] = process.argv.slice(2);
  if (!file || flags.some((flag) => flag !== '--allow-missing-packages')) {
    console.error('usage: check-lane-filters.mjs <nextest-list.json> [--allow-missing-packages]');
    process.exit(2);
  }
  const list = JSON.parse(readFileSync(file, 'utf8'));
  const problems = checkLanes(list, { allowMissingPackages: flags.length > 0 });
  const tests = runnableTestsByPackage(list);
  for (const [lane, { pkg, filters }] of Object.entries(LANES)) {
    if (tests.has(pkg))
      console.log(
        `lane ${lane}: ${(filters.length ? filters : ['(all)']).join(', ')} over ${tests.get(pkg).length} runnable tests of ${pkg}`
      );
    else console.log(`lane ${lane}: ${pkg} is not in the archive`);
  }
  for (const problem of problems) console.error(problem);
  process.exit(problems.length ? 1 : 0);
}
