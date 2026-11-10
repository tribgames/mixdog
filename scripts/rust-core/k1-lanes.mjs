#!/usr/bin/env node
// The Rust-core replacements of the Node CI steps that K1 removes (see k1-ci-replacements.md). Each lane is one
// `cargo test` run per filter over tests in native/core. cargo passes a filter that matches nothing, and libtest skips
// an ignored test it matched, so each run first lists what the filter selects (`-- --list`, less `-- --list --ignored`)
// and fails on zero; k1-lanes.slow.test.mjs proves the same for every filter.
// Usage: node scripts/rust-core/k1-lanes.mjs [--list] [--dry-run] [--runner "cargo test"] [lane...]   (no lane: all;
// --dry-run prints each lane, filter and command without running cargo). MIXDOG_CARGO, when set, is the command run in
// place of cargo (a local build gate, e.g. `powershell -NoProfile -File D:\mixdog-build\tools\cargo-gate.ps1`); CI runs
// plain cargo.
import { dirname, relative as relativePath, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTree } from './lib/process-tree.mjs';

// On Windows cargo may be a .cmd shim (a wrapper that queues builds), which only a shell resolves.
const SHELL = process.platform === 'win32';
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../native/core');

// package.json scripts and workflow steps each lane stands in for.
export const LANES = {
  'shell-direct-exe': { replaces: 'scripts/suite-shell-direct-exe-test.mjs', pkg: 'mixdog-tools', filters: ['exec::direct::tests'] },
  'advisory-lock': { replaces: 'advisory-lock.slow.test.mjs (release-gate runtime-slow)', pkg: 'mixdog-tools', filters: ['the_advisory_lock_waits_for_a_live_holder', 'edit_and_apply_patch_wait_for_the_advisory_lock'] },
  'patch-bytes': { replaces: 'scripts/native-edit-wire-test.mjs, scripts/patch-replay.mjs', pkg: 'mixdog-tools', filters: ['fs::tests'] },
  'provider-contract': { replaces: 'scripts/provider-contract-test.mjs, provider-stream-outcome-test.mjs, cursor-provider-test.mjs, openai-codex-identity.test.mjs, openai-ws-delta-parity.test.mjs', pkg: 'mixdog-ai', filters: [] },
  'daemon-bootstrap': { replaces: 'scripts/daemon-bootstrap-test.mjs, src/standalone/session-runtime-inline-host.test.mjs', pkg: 'mixdog-app-server-daemon', filters: ['boot_coordinator', 'server_ensure::tests::a_run_that_meets_a_live_install_before_its_core_is_published'] },
  'native-assets': { replaces: 'scripts/prepare-native-assets.mjs, scripts/prepare-native-assets-test.mjs (fetch + verify of the native tool binaries)', pkg: 'mixdog-services', filters: ['native_asset::tests'] },
  'compact': { replaces: 'scripts/compact-smoke.mjs', pkg: 'mixdog-agent', filters: ['compact_fresh', 'compact_handoff', 'compact_summary', 'compact_commit'] },
  'turn-contract': { replaces: 'scripts/run-advisory-spec.mjs (runtime-turn-contract-test.mjs)', pkg: 'mixdog-agent', filters: ['run_loop', 'turns::'] },
  'request-snapshot': { replaces: 'benchmarks/terminal-bench-2.1/analysis/contract-hash.mjs', pkg: 'mixdog-core', filters: ['run_host::request_snapshot'] },
};

/** One cargo run of `lane` for one libtest filter (cargo takes a single filter per run). */
export function commandOf(lane, runner = 'cargo test', filter = null) {
  const [program, ...head] = runner.split(' ');
  return { program, args: [...head, '-p', LANES[lane].pkg, '--locked', ...(filter ? [filter] : [])] };
}

// A cargo run (a compile included) that has not finished by now is stuck, not slow: it is ended with everything it started.
const DEADLINE_MS = 3_600_000;
// The test children skip the user-data backup guard, as Node's own tests do: without it every config open and write in
// a test makes two backup snapshots (one test: 35.3 s without, 4.6 s with). The one test that asserts on the guard's
// jobs pins its own environment (mixdog-core-config tests/config_lanes.rs).
const CHILD_ENV = { ...process.env, MIXDOG_SKIP_USER_DATA_BACKUP: '1' };

/** One cargo command of a lane, to its exit, under the deadline; `label` names the lane and the step in a failure. */
export function runChild(program, args, { label = `${program} ${args.join(' ')}`, cwd = CORE, deadlineMs = DEADLINE_MS, inherit = false } = {}) {
  // MIXDOG_CARGO is a command line (a program with its own arguments), which only a shell splits.
  const gate = program === 'cargo' ? process.env.MIXDOG_CARGO : undefined;
  return runTree(gate || program, args, { label, cwd, env: CHILD_ENV, deadlineMs, inherit, shell: Boolean(gate) || (SHELL && program === 'cargo') });
}

/** The test binaries in the output of `cargo test --no-run --message-format=json` (its `compiler-artifact` messages). */
export function testBinariesOf(buildStdout) {
  return buildStdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((message) => message.reason === 'compiler-artifact' && message.profile?.test && message.executable);
}

/**
 * The tests a libtest binary runs, from its `--list` output and its `--list --ignored` output (the same filter), each with
 * the source path of the binary that listed them. `--list` names the `#[ignore]`d tests too, which the run skips: they
 * are left out, so a filter whose only match is ignored selects nothing.
 */
export function testsOfList(listStdout, ignoredStdout, srcPath) {
  const names = (stdout) => stdout.split(/\r?\n/).filter((line) => line.endsWith(': test')).map((line) => line.slice(0, -': test'.length));
  const ignored = new Set(names(ignoredStdout));
  return names(listStdout).filter((name) => !ignored.has(name)).map((name) => ({ name, srcPath }));
}
/**
 * The tests one lane filter selects that the run will run, each with the test binary (its source path) that holds it.
 * cargo runs a filter that matches nothing and reports success, and libtest skips an ignored test it matched, so a lane
 * must see at least one test here before it runs. The binaries come from cargo's own build messages and each is listed by
 * libtest's `--list` (and `--list --ignored`, which is left out), so the binary of a test is known, not guessed from its
 * name: a standalone integration-test binary (tests/ticker.rs) names its tests without any file prefix.
 * @returns {Promise<{ name: string, srcPath: string }[]>}
 */
export async function selectedTests(lane, filter = null, { pkg = LANES[lane].pkg, ...options } = {}) {
  const label = `lane ${lane} (filter ${filter ?? '(all)'}, preflight listing)`;
  const build = await runChild('cargo', ['test', '-p', pkg, '--locked', '--no-run', '--message-format=json'], { label: `${label} build`, ...options });
  if (build.status !== 0) throw new Error(`cargo test --no-run failed for lane ${lane} (filter ${filter ?? '(all)'})\n${build.stderr}`);
  const selected = [];
  for (const binary of testBinariesOf(build.stdout)) {
    const list = async (...mode) => {
      const listed = await runChild(binary.executable, ['--list', ...mode, ...(filter ? [filter] : [])], { label: `${label} of ${binary.target.name}`, cwd: dirname(binary.manifest_path), ...options });
      if (listed.status !== 0) throw new Error(`${binary.target.name} --list ${mode.join(' ')} failed for lane ${lane} (filter ${filter ?? '(all)'})\n${listed.stderr}`);
      return listed.stdout;
    };
    selected.push(...testsOfList(await list(), await list('--ignored'), binary.target.src_path));
  }
  return selected;
}

/**
 * The files of `recorded/` as cargo produces them now, in the form they are stored: the lib test target of mixdog-tools
 * (`cargo test -p mixdog-tools --locked --no-run --message-format=json`, its compiler-artifact message) and what its binary
 * lists for `fs::tests`. Machine-specific paths become repository-relative ones and the executable a placeholder.
 * `recorded/manifest.json` names each file's command; record-lanes-fixtures.mjs writes them, k1-lanes.slow.test.mjs
 * compares them with a fresh run and fails on a difference.
 * @returns {Promise<Record<string, string>>} file name -> content
 */
export async function lanesFixtures(options = {}) {
  const build = await runChild('cargo', ['test', '-p', 'mixdog-tools', '--locked', '--no-run', '--message-format=json'], { label: 'recorded fixtures build', ...options });
  if (build.status !== 0) throw new Error(`cargo test --no-run failed for the recorded fixtures\n${build.stderr}`);
  const binary = testBinariesOf(build.stdout).find((message) => message.target.name === 'mixdog_tools' && message.target.kind.includes('lib'));
  if (!binary) throw new Error('the build has no lib test binary of mixdog_tools');
  const listed = await runChild(binary.executable, ['--list', 'fs::tests'], { label: 'recorded fixtures list', cwd: dirname(binary.manifest_path), ...options });
  if (listed.status !== 0) throw new Error(`mixdog_tools --list fs::tests failed\n${listed.stderr}`);
  const srcPath = relative(binary.target.src_path);
  const artifact = {
    reason: binary.reason,
    package: binary.package_id.replace(/^.*#/, ''),
    manifest_path: relative(binary.manifest_path),
    target: { kind: binary.target.kind, name: binary.target.name, src_path: srcPath },
    profile: { test: binary.profile.test },
    executable: '<test binary>',
  };
  return {
    'lanes_build_messages.jsonl': `${JSON.stringify(artifact)}\n`,
    'lanes_list_fs_tests.json': `${JSON.stringify({ mixdog_tools: { src_path: srcPath, list: listed.stdout } }, null, 1)}\n`,
  };
}
// Test files that install an executor backend of their own (`mixdog_rt::install` / `exec::boot` / `boot_executors`): the
// backend is once per process, so such a test only passes in a process of its own (nextest, or one invocation per
// test). A lane whose filter selects one of them next to any other test must run under nextest; k1-lanes.test.mjs
// checks that no lane does today and that this list holds every file that installs one.
export const BACKEND_INSTALLERS = [
  'native/core/crates/mixdog-app-server-daemon/tests/it/real_executors.rs',
  'native/core/crates/mixdog-core-config/tests/config_lanes.rs',
  'native/core/crates/mixdog-core-session/tests/never_ran_reads.rs',
  'native/core/crates/mixdog-core/tests/it/bot_routes_never_ran.rs',
  'native/core/crates/mixdog-ledger/tests/sums_lanes.rs',
  'native/core/crates/mixdog-mcp/tests/it/skill_catalog_suite.rs',
  'native/core/crates/mixdog-rt/tests/executors.rs',
  'native/core/crates/mixdog-rt/tests/lane_wedged.rs',
  'native/core/crates/mixdog-rt/tests/submit_wait.rs',
  'native/core/crates/mixdog-rt/tests/ticker.rs',
  'native/core/crates/mixdog-services/src/tidy/process.rs',
];

const REPO = resolve(CORE, '../..');
const relative = (path) => relativePath(REPO, path).split(sep).join('/');

/**
 * Whether the test `name` of the binary built from `srcPath` is in the installer `file`. A standalone test binary
 * (`file` is its crate root) holds the installer wholly. A binary that gathers modules (tests/it/main.rs, src/lib.rs)
 * holds it as the module the file path names (tests/it/x.rs -> `x::`, src/a/b.rs -> `a::b::`).
 */
export function isInstalledBy(file, { name, srcPath }) {
  const root = relative(srcPath);
  if (root === file) return true;
  const base = root.slice(0, root.lastIndexOf('/') + 1);
  if (!file.startsWith(base)) return false;
  return name.startsWith(`${file.slice(base.length, -'.rs'.length).split('/').join('::')}::`);
}

/** The installing tests among the selected `tests` (`{ name, srcPath }`), decided by the binary each is in. */
export const installersIn = (tests) => tests.filter((test) => BACKEND_INSTALLERS.some((file) => isInstalledBy(file, test)));

/** The command line: lane names (positional), `--runner <cmd>`, `--list`, `--dry-run`. */
export function parseArgs(argv) {
  const options = { runner: 'cargo test', list: false, dryRun: false, names: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runner') {
      i += 1;
      if (argv[i] === undefined) throw new Error('--runner needs a command');
      options.runner = argv[i];
    } else if (arg === '--list') options.list = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.names.push(arg);
  }
  return options;
}

async function main(argv) {
  const { runner, list, dryRun, names } = parseArgs(argv);
  for (const name of names) if (!Object.hasOwn(LANES, name)) throw new Error(`unknown lane ${name}; known: ${Object.keys(LANES).join(', ')}`);
  if (list) {
    for (const [name, lane] of Object.entries(LANES)) console.log(`${name}\t${lane.replaces}`);
    return 0;
  }
  const selected = names.length ? names : Object.keys(LANES);
  for (const name of selected) {
    const { filters } = LANES[name];
    for (const filter of filters.length ? filters : [null]) {
      const run = commandOf(name, runner, filter);
      if (dryRun) {
        console.log(`${name}\t${filter ?? '(all)'}\t${run.program} ${run.args.join(' ')}`);
        continue;
      }
      const selectedNames = await selectedTests(name, filter);
      if (selectedNames.length === 0) {
        console.error(`lane ${name}: filter ${filter ?? '(all)'} selects no test that runs (ignored tests are not counted)`);
        return 1;
      }
      const installers = installersIn(selectedNames);
      if (installers.length && !runner.includes('nextest')) {
        console.error(`lane ${name}: filter ${filter ?? '(all)'} selects tests that install an executor backend of their own (${installers.slice(0, 3).join(', ')}), which only pass in a process each: run the lane with --runner "cargo nextest run"`);
        return 1;
      }
      console.log(`== ${name}: ${run.program} ${run.args.join(' ')}  (${selectedNames.length} tests)`);
      const result = await runChild(run.program, run.args, { label: `lane ${name} (filter ${filter ?? '(all)'})`, inherit: true });
      if (result.status !== 0) return result.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
