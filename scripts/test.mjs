#!/usr/bin/env node
// Discovery-based test entry (docs/testing.md). A test file joins the suite
// by existing; its lane comes from its name, never from a hand-kept list:
//
//   *.test.mjs           fast     the default lane; every push, every local run
//   *.slow.test.mjs      slow     files over ~10s; their own CI job
//   *.live.test.mjs      live     need a built artifact or a live system
//   *.electron.test.mjs  electron need a real Electron or window-capture
//                                 surface, so two runs of them cannot overlap
//
// The electron lane is not part of the default lane: `--lane electron` runs
// those files alone, and `--lane all` includes them unless `--exclude-lane
// electron` lets a second run proceed concurrently.
//
// Usage — see USAGE below (`node scripts/test.mjs --help`).
//
// Runs from the package that invokes it: `src/`, `scripts/`, `lib/`, `deploy/`
// and the package root itself are searched under cwd, so the root package,
// apps/desktop and apps/relay share this one entry. A root a package does not
// have simply yields nothing. The root package also discovers the workspace
// packages under `packages/` (their `.test.ts` files too) and the npm launcher
// under `apps/mixdogd-npm`, so no Node test sits outside every lane.
import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginReceipt, childrenOf, finishReceipt } from './ci/receipt.mjs';
import { DEFAULT_TEST_TIMEOUT_MS, LONG_TEST_TIMEOUT_MS, runNodeTests } from './lib/run-node-tests.mjs';

const FILE_LANES = ['fast', 'slow', 'live', 'electron'];
const LANES = [...FILE_LANES, 'all'];

export const USAGE = `Usage: node scripts/test.mjs [--lane ${LANES.join('|')}] [--exclude-lane <lane>]...
                             [--exclude-path <path>]...
                             [--rerun-failed <n>] [--list] [--coverage] [--changed]
                             [--import <spec>]... [--test-*]... [filter...]
  filter          substring of a file path; only matching files run.
  --changed       only the selected files whose relative imports, file URLs or
                  // @test-input declarations reach a repository change (edits,
                  deletions and untracked files). An input declaration is relative
                  to its source file; a trailing slash covers a directory.
                  Unreached changes in this package are listed. Run their tests
                  with a path filter instead of --changed.
  --lane          fast is the default; electron needs a real desktop and only
                  runs with --lane electron or --lane all.
  --exclude-lane  drop one lane from the selection, repeatable. Electron and
                  window-capture tests cannot run twice at once, so a second
                  concurrent --lane all run uses --exclude-lane electron.
  --exclude-path  omit one file or directory relative to the invoking package,
                  repeatable.
  --rerun-failed <n>  re-run the failed files up to n times to classify flaky
                  tests. Default 0: every failure fails the run;
                  MIXDOG_TEST_RERUN_FAILED overrides the default. A test that
                  passes on a re-run is reported as flaky and does NOT fail the
                  run; a test that fails every re-run still exits 1.
  Per-file timeout: --test-timeout (default 120000 ms for the fast lane, 600000
                  ms otherwise); MIXDOG_TEST_TIMEOUT_MS overrides, 0 disables.
  --import        forwarded to node (desktop passes its test-env and tsx loaders).
  --expose-gc     forwarded to node (the retention suites skip without it).
  --test-*        forwarded to node --test (e.g. --test-name-pattern, --test-only).
  --coverage      collect V8 coverage (NODE_V8_COVERAGE, no dependency) and fold
                  it into .runtime/coverage/coverage.json, which answers "did the
                  suite execute this function?" — see scripts/coverage-query.mjs.
                  Selection, lanes, reporting and exit codes are untouched.
  --list          print the selected files with their lane, run nothing.

Test-file rule: files run with --test-force-exit, so a file's top-level
evaluation (including any top-level await) must finish before its registered
tests do. A file that is force-exited first fails — tests registered after the
await would never run, and an await that never settles cannot be told apart.

Every run ends with a "[failure-summary]" block, printed after all other
output, naming each failed and flaky test by file and test name; every line of
it carries that tag, so it survives line filtering.`;

// Not all of `benchmarks`: its job directories hold thousands of run artifacts
// (some unreadable), so only the analysis tooling that has tests is searched.
const ROOTS = [
  '.',
  'src',
  'scripts',
  'lib',
  'deploy',
  'benchmarks/terminal-bench-2.1/analysis',
  'apps/mixdogd-npm',
  'packages',
];
const PATTERNS = ['**/*.test.mjs', '**/*-test.mjs'];
// The workspace packages are TypeScript: their tests are `.test.ts` as well
// (the root loader, tsx, runs them).
const ROOT_PATTERNS_BY_ROOT = { packages: [...PATTERNS, '**/*.test.ts'] };
// The package root is searched shallowly: a recursive pattern there would pull
// every workspace package into the invoking package's suite.
const ROOT_PATTERNS = ['*.test.mjs', '*-test.mjs'];
// One glob invocation shares directory reads across its patterns. Keep the
// root patterns shallow even though the other roots are recursive.
const DISCOVERY_PATTERNS = ROOTS.flatMap((root) =>
  root === '.' ? ROOT_PATTERNS : (ROOT_PATTERNS_BY_ROOT[root] ?? PATTERNS).map((pattern) => `${root}/${pattern}`)
);
// node-oracle contains explicit comparison suites. Their reference checkout
// or local recordings are not available to the regular lanes.
const EXCLUDED_DIRS = new Set(['node_modules', '.runtime', 'out', 'dist', 'target', 'node-oracle']);
const inExcludedDir = (path) => String(path).split(/[\\/]/).some((segment) => EXCLUDED_DIRS.has(segment));
// Directories (relative to the invoking package) whose tests need a built core, its process-tree helper or cargo, so no
// plain Node lane runs them: they start mixdogd or compile (scripts/rust-core/core-session.test.mjs and
// smoke-mixdogd.test.mjs fail without MIXDOGD_BIN, the helper's tests need the helper built). The job that has built
// what they need names them: release-gate.yml `core-real`.
const EXCLUDED_PATHS = ['scripts/rust-core'];
const matchesPath = (file, paths) => paths.some((path) => file === path || file.startsWith(`${path}/`));
const underExcludedPath = (file) => matchesPath(file, EXCLUDED_PATHS);

export function laneOf(file) {
  if (/\.live\.test\.mjs$/.test(file)) return 'live';
  if (/\.slow\.test\.mjs$/.test(file)) return 'slow';
  if (/\.electron\.test\.mjs$/.test(file)) return 'electron';
  return 'fast';
}

function rerunCount(value) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`--rerun-failed requires a non-negative integer (got "${value}")`);
  }
  return Number(value);
}

// Every failure fails the run, locally and in CI: a test that passes only on a
// re-run is a defect to fix, not a pass. Re-runs happen only on an explicit
// --rerun-failed or MIXDOG_TEST_RERUN_FAILED, to classify a failure as flaky.
export function defaultRerunFailed(env = process.env) {
  return /^\d+$/.test(String(env.MIXDOG_TEST_RERUN_FAILED ?? '')) ? Number(env.MIXDOG_TEST_RERUN_FAILED) : 0;
}

export function parseArgs(argv) {
  const options = { lane: 'fast', list: false, nodeArgs: [], filters: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--lane') options.lane = argv[++index];
    else if (arg.startsWith('--lane=')) options.lane = arg.slice('--lane='.length);
    else if (arg === '--list') options.list = true;
    // Opt-in only: an absent flag leaves the parsed options exactly as they
    // were, so nothing downstream can branch on coverage, lane exclusion or
    // re-runs by accident.
    else if (arg === '--coverage') options.coverage = true;
    // Two session-lane suites measure retention with `globalThis.gc` and skip without it; a lane that must run them passes this.
    else if (arg === '--expose-gc') options.nodeArgs.push(arg);
    else if (arg === '--changed') options.changed = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--exclude-lane') options.excludeLanes = [...(options.excludeLanes ?? []), argv[++index]];
    else if (arg.startsWith('--exclude-lane='))
      options.excludeLanes = [...(options.excludeLanes ?? []), arg.slice('--exclude-lane='.length)];
    else if (arg === '--exclude-path') {
      const path = argv[++index];
      if (!path || path.startsWith('--')) throw new Error('--exclude-path requires a path');
      options.excludePaths = [...(options.excludePaths ?? []), path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')];
    }
    else if (arg === '--rerun-failed') options.rerunFailed = rerunCount(argv[++index]);
    else if (arg.startsWith('--rerun-failed=')) options.rerunFailed = rerunCount(arg.slice('--rerun-failed='.length));
    else if (arg === '--import') {
      const spec = argv[++index];
      if (spec === undefined) throw new Error('--import requires a value');
      options.nodeArgs.push(arg, spec);
    } else if (arg === '--test-timeout' || arg === '--test-concurrency') {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      options.nodeArgs.push(`${arg}=${value}`);
    } else if (arg.startsWith('--import=') || arg.startsWith('--test-')) options.nodeArgs.push(arg);
    else options.filters.push(arg.replaceAll('\\', '/'));
  }
  if (!LANES.includes(options.lane)) {
    throw new Error(`unknown lane "${options.lane}" (${LANES.join('|')})`);
  }
  for (const lane of options.excludeLanes ?? []) {
    if (!FILE_LANES.includes(lane)) {
      throw new Error(`unknown excluded lane "${lane}" (${FILE_LANES.join('|')})`);
    }
  }
  return options;
}

export async function discoverTestFiles(cwd = process.cwd()) {
  const files = new Set();
  for await (const entry of glob(DISCOVERY_PATTERNS, { cwd, exclude: inExcludedDir })) {
    const file = entry.replaceAll('\\', '/');
    if (!underExcludedPath(file)) files.add(file);
  }
  return [...files].sort();
}

export function laneSelected(lane, fileLane) {
  return lane === 'all' || lane === fileLane;
}

export function selectTestFiles(files, { lane, filters, excludeLanes = [], excludePaths = [] }) {
  const excluded = new Set(excludeLanes);
  return files
    .filter((file) => laneSelected(lane, laneOf(file)) && !excluded.has(laneOf(file)))
    .filter((file) => !matchesPath(file, excludePaths))
    .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)));
}

// MIXDOG_RECEIPT=<file>: this invocation's receipt (scripts/ci/receipt.mjs): created here before anything runs (an existing file is an
// error), filled by the skip reporter (tests that ran, every skipped or todo test) and closed when the last test process has ended, for
// scripts/ci/check-skips.mjs. The reporter is added to this run's test processes only and the file travels in its URL; the variable is
// dropped from the environment the tests inherit, so a runner a test starts over a fixture does not write the lane's receipt. A runner
// a test starts for a suite whose result counts (scripts/ci/node-runner.mjs) finds MIXDOG_CHILD_RECEIPTS instead and leaves a receipt of
// its own there. The warning is off because the runner already pipes three reporters from one stream and this is the fourth.
const SKIP_REPORTER = new URL('./ci/skip-reporter.mjs', import.meta.url);
export function skipReportArgs(env = process.env) {
  const file = env.MIXDOG_RECEIPT;
  if (!file) return [];
  delete env.MIXDOG_RECEIPT;
  beginReceipt(resolve(file), 'node');
  env.MIXDOG_CHILD_RECEIPTS = childrenOf(resolve(file));
  const reporter = new URL(SKIP_REPORTER);
  reporter.searchParams.set('out', resolve(file));
  return ['--disable-warning=MaxListenersExceededWarning', `--test-reporter=${reporter.href}`, '--test-reporter-destination=stdout'];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // A run that leaves evidence for the release proof is one execution of each test: a re-run that turns a failure green would hide it.
  if (process.env.MIXDOG_RECEIPT && !options.help && !options.list && (options.rerunFailed ?? defaultRerunFailed()) > 0) {
    throw new Error('--rerun-failed and MIXDOG_TEST_RERUN_FAILED are not allowed in a run that leaves release evidence (MIXDOG_RECEIPT)');
  }
  const receipt = process.env.MIXDOG_RECEIPT && !options.help && !options.list ? resolve(process.env.MIXDOG_RECEIPT) : null;
  options.nodeArgs.push(...(options.help || options.list ? [] : skipReportArgs()));
  let threw = true;
  try {
    await run(options);
    threw = false;
  } finally {
    if (receipt) finishReceipt(receipt, threw ? 1 : (process.exitCode ?? 0));
  }
}

async function run(options) {
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const changes = options.changed ? await import('./lib/changed-tests.mjs') : null;
  const changed = changes?.changedFiles();
  // No tests or unreached paths can be reported when there are no changes.
  const discovered = changed?.length === 0 ? [] : await discoverTestFiles();
  let files = selectTestFiles(discovered, options);
  if (changes) {
    // The graph spans every discovered test, so "no test imports it" means none
    // in this package; the lane and filters then narrow what actually runs.
    const { selected, unreached: everywhere } = changes.selectChangedTests(discovered, changed);
    const reaching = new Set(selected);
    files = files.filter((file) => reaching.has(file));
    // A referenced input can be outside this package. Diagnostics for paths
    // with no test edge stay local and leave out separately run suites.
    const unreached = everywhere.filter(
      (file) =>
        !inExcludedDir(file) &&
        !underExcludedPath(file) &&
        !matchesPath(file, options.excludePaths ?? []) &&
        ROOTS.some((root) => (root === '.' ? !file.includes('/') : file.startsWith(`${root}/`))) &&
        (options.filters.length === 0 || options.filters.some((filter) => file.includes(filter)))
    );
    if (unreached.length) {
      console.error(`--changed: no discovered test reaches ${unreached.length} changed file(s); run their tests with a path filter and without --changed:`);
      for (const file of unreached) console.error(`  ${file}`);
    }
    if (!files.length) {
      console.error(`--changed: no ${options.lane} test file matching the filters reaches a changed file`);
      if (unreached.length) process.exitCode = 1;
      return;
    }
  }
  if (options.list) {
    for (const file of files) console.log(`${laneOf(file).padEnd(5)} ${file}`);
    return;
  }
  if (files.length === 0) {
    console.error(`no ${options.lane} test files match ${options.filters.join(' ') || '(everything)'}`);
    process.exitCode = 1;
    return;
  }
  // The root package loads TypeScript through tsx; apps/desktop passes its own loader, apps/relay has none.
  const rootPackage = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const rootLoader = resolve(process.cwd()) === rootPackage ? ['--import', new URL('./test-tsx.mjs', import.meta.url).href] : [];
  await runNodeTests(
    [
      ...rootLoader,
      ...options.nodeArgs,
      // node:test `mock.module` (module-boundary stubs such as the pinned fetch
      // in the browser-document live suite) is still flag-gated on 22/24.
      '--experimental-test-module-mocks',
      '--test',
      // A suite that leaves a handle open (a session runtime closed without
      // waiting for its children) must not hang the whole run.
      '--test-force-exit',
    ],
    files,
    {
      coverage: options.coverage === true,
      rerunFailed: options.rerunFailed ?? defaultRerunFailed(),
      testTimeoutMs: options.lane === 'fast' ? DEFAULT_TEST_TIMEOUT_MS : LONG_TEST_TIMEOUT_MS,
    }
  );
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) await main();
