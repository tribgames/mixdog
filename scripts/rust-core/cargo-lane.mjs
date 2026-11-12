#!/usr/bin/env node
// One Rust-core lane of CI: `cargo test` of a native/core package, once per libtest filter (cargo takes one filter
// per run; none runs the whole package). cargo reports success for a filter that matches no test, so each run first
// lists what the filter selects (`-- --list`) and the lane fails on none.
// Usage: node scripts/rust-core/cargo-lane.mjs <package> [filter...]
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../native/core');

/** The tests a filter selects, from libtest's own `--list`. */
export function selectedTests(listing) {
  return listing
    .split(/\r?\n/)
    .filter((line) => line.endsWith(': test'))
    .map((line) => line.slice(0, -': test'.length));
}

const cargo = (args) => spawnSync('cargo', args, { cwd: CORE, encoding: 'utf8', maxBuffer: 64 << 20 });
const cargoInherit = (args) => spawnSync('cargo', args, { cwd: CORE, stdio: 'inherit' });

/** @returns {number} the exit code of the lane */
export function runLane(pkg, filters, { list = cargo, run = cargoInherit, log = console } = {}) {
  for (const filter of filters.length ? filters : [null]) {
    const args = ['test', '-p', pkg, '--locked', ...(filter ? [filter] : [])];
    const listed = list([...args, '--', '--list']);
    if (listed.status !== 0) {
      log.error(`cargo ${args.join(' ')} --list failed\n${listed.stderr}`);
      return listed.status ?? 1;
    }
    const count = selectedTests(listed.stdout).length;
    if (count === 0) {
      log.error(`lane ${pkg}: filter ${filter ?? '(all)'} selects no test`);
      return 1;
    }
    log.log(`== cargo ${args.join(' ')}  (${count} tests)`);
    const result = run(args);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pkg, ...filters] = process.argv.slice(2);
  if (!pkg) {
    console.error('usage: cargo-lane.mjs <package> [filter...]');
    process.exitCode = 2;
  } else {
    process.exitCode = runLane(pkg, filters);
  }
}