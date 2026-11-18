#!/usr/bin/env node
// Runs `cargo nextest run` and leaves the receipt of the invocation (scripts/ci/receipt.mjs) from nextest's own structured report:
// one record per terminal testcase of its JUnit file, identified by binary (package, target kind, target name) and the full libtest
// path. No output text and no listing is read. An ignored test is skip evidence only when nextest itself reported it skipped in this
// invocation's report (`junit.report-skipped = "ignored"` of the `ci` profile, native/core/.config/nextest.toml): in a default run that
// is exactly a selected test whose #[ignore] kept it from running. Under `--run-ignored only|all` a skipped element would be a test the
// mode deselected, not an ignore disposition, so a report that holds one fails the invocation.
//
//   MIXDOG_RECEIPT=<file> node scripts/ci/run-nextest.mjs --junit <junit.xml> [--list] -- <scope args> [-- <run-only args>]
//
// `--list` (a standalone crate, which has no build-variant listing of its own) also records nextest's own listing of the run's scope in
// the receipt: which binaries it has and how many tests each holds, so a target that vanished, or one that never ran, is visible.
//
// <scope args> (--manifest-path, --archive-file, --workspace-remap, --config-file, --profile, --features, -E ...) and <run-only args>
// (--partition, --no-tests, --run-ignored, --status-level ...) both go to the run. Retries are not allowed: a JUnit retry element is a
// failed record. Without MIXDOG_RECEIPT the run is plain nextest.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { junitRecords, packagesByName, suiteNames } from './coverage/adapters.mjs';
import { beginReceipt, finishReceipt, receiptPath } from './receipt.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function splitArgs(argv) {
  const options = { junit: null, list: false };
  let at = 0;
  for (; at < argv.length && argv[at] !== '--'; at += 1) {
    if (argv[at] === '--junit') options.junit = argv[++at];
    else if (argv[at] === '--list') options.list = true;
    else throw new Error(`unknown option ${argv[at]}`);
  }
  const rest = argv.slice(at + 1);
  const second = rest.indexOf('--');
  return { options, scope: second < 0 ? rest : rest.slice(0, second), extra: second < 0 ? [] : rest.slice(second + 1) };
}

/** The invocation's `--run-ignored` mode: `default` (ignored tests are skipped), `only` or `all`. */
export function runIgnoredMode(args) {
  for (const [index, arg] of args.entries()) {
    if (arg === '--run-ignored') return args[index + 1];
    if (arg.startsWith('--run-ignored=')) return arg.slice('--run-ignored='.length);
  }
  return 'default';
}

/** The records of one invocation's JUnit report, and why the report cannot be evidence of it. */
export function invocationRecords(xml, byName, args) {
  const records = junitRecords(xml, byName);
  const mode = runIgnoredMode(args);
  const problems = mode === 'default' ? [] : records.filter((record) => record.status === 'ignored').map((record) => `${JSON.stringify(record.id)} is reported skipped under --run-ignored ${mode}: that is the mode's deselection, not an ignore disposition`);
  return { records, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { options, scope, extra } = splitArgs(process.argv.slice(2));
  if (!options.junit || scope.length === 0) {
    console.error('usage: run-nextest.mjs --junit <junit.xml> -- <scope args> [-- <run-only args>]');
    process.exit(2);
  }
  const env = { ...process.env };
  const receipt = receiptPath(env);
  delete env.MIXDOG_RECEIPT;
  delete env.MIXDOG_CHILD_RECEIPTS;
  if (receipt) beginReceipt(receipt, 'nextest');
  const read = (path) => readFileSync(join(ROOT, path), 'utf8');
  const tracked = receipt ? spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.split('\0').filter(Boolean) : [];
  const byName = receipt ? packagesByName(tracked, read).byName : null;
  if (existsSync(options.junit)) rmSync(options.junit);
  let listing;
  if (receipt && options.list) {
    const listed = spawnSync('cargo', ['nextest', 'list', ...scope, '--message-format', 'json'], { env, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
    if (listed.status !== 0) console.error('cargo nextest list failed: the receipt cannot say which targets exist');
    else listing = suiteNames(JSON.parse(listed.stdout));
  }
  const run = spawnSync('cargo', ['nextest', 'run', ...scope, ...extra], { env, stdio: 'inherit' });
  let status = run.status ?? 1;
  if (receipt && options.list && listing === undefined) status = 1;
  if (receipt) {
    let records = [];
    if (existsSync(options.junit)) {
      const read1 = invocationRecords(readFileSync(options.junit, 'utf8'), byName, [...scope, ...extra]);
      records = read1.records;
      for (const problem of read1.problems) console.error(problem);
      if (read1.problems.length) status = 1;
    } else if (status === 0) {
      console.error(`nextest left no JUnit report at ${options.junit}`);
      status = 1;
    }
    finishReceipt(receipt, status, { records, listing });
  }
  process.exit(status);
}
