#!/usr/bin/env node
// The Rust-core replacements of the Node CI steps that K1 removes (see k1-ci-replacements.md). Each lane is one
// `cargo test` run per filter over tests that already exist in native/core. cargo passes a filter that matches
// nothing, so each run first lists what the filter selects (`-- --list`) and fails on zero; k1-lanes.test.mjs
// proves the same for every filter.
// Usage: node scripts/rust-core/k1-lanes.mjs [--list] [--runner "cargo test"] [lane...]   (no lane: all)
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** The tests one lane filter selects, from libtest's own `--list`. cargo runs a filter that matches nothing and
 *  reports success, so a lane must see at least one name here before it runs. */
export function selectedTests(lane, filter = null, cwd = CORE) {
  const result = spawnSync('cargo', ['test', '-p', LANES[lane].pkg, '--locked', ...(filter ? [filter] : []), '--', '--list'], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.status !== 0) throw new Error(`cargo test --list failed for ${lane} ${filter ?? ''}\n${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter((line) => line.endsWith(': test')).map((line) => line.slice(0, -': test'.length));
}

function main(argv) {
  const runnerAt = argv.indexOf('--runner');
  const runner = runnerAt >= 0 ? argv[runnerAt + 1] : 'cargo test';
  const names = argv.filter((arg, i) => !arg.startsWith('--') && i !== runnerAt + 1);
  if (argv.includes('--list')) {
    for (const [name, lane] of Object.entries(LANES)) console.log(`${name}\t${lane.replaces}`);
    return 0;
  }
  const selected = names.length ? names : Object.keys(LANES);
  for (const name of selected) if (!LANES[name]) throw new Error(`unknown lane ${name}; known: ${Object.keys(LANES).join(', ')}`);
  for (const name of selected) {
    const { filters } = LANES[name];
    for (const filter of filters.length ? filters : [null]) {
      const run = commandOf(name, runner, filter);
      const count = selectedTests(name, filter).length;
      if (count === 0) {
        console.error(`lane ${name}: filter ${filter ?? '(all)'} selects no test`);
        return 1;
      }
      console.log(`== ${name}: ${run.program} ${run.args.join(' ')}  (${count} tests)`);
      const result = spawnSync(run.program, run.args, { cwd: CORE, stdio: 'inherit' });
      if (result.status !== 0) return result.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
