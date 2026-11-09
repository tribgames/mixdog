#!/usr/bin/env node
// The Rust-core replacements of the Node CI steps that K1 removes (see k1-ci-replacements.md). Each lane is one
// `cargo test` run per filter over tests that already exist in native/core. cargo passes a filter that matches
// nothing, so each run first lists what the filter selects (`-- --list`) and fails on zero; k1-lanes.test.mjs
// proves the same for every filter.
// Usage: node scripts/rust-core/k1-lanes.mjs [--list] [--dry-run] [--runner "cargo test"] [lane...]   (no lane: all;
// --dry-run prints each lane, filter and command without running cargo)
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// On Windows cargo may be a .cmd shim (a wrapper that queues builds), which only a shell resolves.
const SHELL = process.platform === 'win32';
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../native/core');

// package.json scripts and workflow steps each lane stands in for.
export const LANES = {
  'shell-direct-exe': { replaces: 'scripts/suite-shell-direct-exe-test.mjs', pkg: 'mixdog-tools', filters: ['exec::direct::tests'] },
  'advisory-lock': { replaces: 'advisory-lock.slow.test.mjs (release-gate runtime-slow)', pkg: 'mixdog-tools', filters: ['the_advisory_lock_waits_for_a_live_holder', 'edit_and_apply_patch_wait_for_the_advisory_lock'] },
  'patch-bytes': { replaces: 'scripts/native-edit-wire-test.mjs, scripts/patch-replay.mjs', pkg: 'mixdog-tools', filters: ['fs::tests'] },
  'provider-contract': { replaces: 'scripts/provider-contract-test.mjs, provider-stream-outcome-test.mjs, cursor-provider-test.mjs, openai-codex-identity.test.mjs, openai-ws-delta-parity.test.mjs', pkg: 'mixdog-ai', filters: [] },
  'daemon-bootstrap': { replaces: 'scripts/daemon-bootstrap-test.mjs, src/standalone/session-runtime-inline-host.test.mjs', pkg: 'mixdog-app-server-daemon', filters: ['boot_coordinator'] },
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

// A cargo run (a compile included) that has not finished by now is stuck, not slow: it is ended and reported.
const DEADLINE_MS = 3_600_000;

/** Ends `child` and everything it started (cargo runs under a shell, and under the wrapper's shim). */
function endTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

/** One child to its exit, with a deadline; the child tree is ended on a timeout and on a spawn error.
 *  Answers `{ status, stdout, stderr }`; `inherit` passes stdio through instead of capturing it. */
export function runChild(program, args, { cwd = CORE, deadlineMs = DEADLINE_MS, inherit = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, { cwd, shell: SHELL, windowsHide: true, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    const deadline = setTimeout(() => {
      endTree(child);
      reject(new Error(`${program} ${args.join(' ')} did not finish within ${deadlineMs}ms and was ended\n${stderr.slice(-600)}`));
    }, deadlineMs);
    child.once('error', (error) => {
      clearTimeout(deadline);
      endTree(child);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(deadline);
      resolveRun({ status, stdout, stderr });
    });
  });
}

/** The tests one lane filter selects, from libtest's own `--list`. cargo runs a filter that matches nothing and
 *  reports success, so a lane must see at least one name here before it runs. */
export async function selectedTests(lane, filter = null, options = {}) {
  const result = await runChild('cargo', ['test', '-p', LANES[lane].pkg, '--locked', ...(filter ? [filter] : []), '--', '--list'], options);
  if (result.status !== 0) throw new Error(`cargo test --list failed for ${lane} ${filter ?? ''}\n${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter((line) => line.endsWith(': test')).map((line) => line.slice(0, -': test'.length));
}

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
  for (const name of names) if (!LANES[name]) throw new Error(`unknown lane ${name}; known: ${Object.keys(LANES).join(', ')}`);
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
      const count = (await selectedTests(name, filter)).length;
      if (count === 0) {
        console.error(`lane ${name}: filter ${filter ?? '(all)'} selects no test`);
        return 1;
      }
      console.log(`== ${name}: ${run.program} ${run.args.join(' ')}  (${count} tests)`);
      const result = await runChild(run.program, run.args, { inherit: true });
      if (result.status !== 0) return result.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
