#!/usr/bin/env node
// Runs `cargo test --doc` for one package and leaves the receipt of the invocation (scripts/ci/receipt.mjs): nextest does not run
// doctests, so this is their runner. libtest prints one `test <name> ... ok|FAILED|ignored` line per doctest on stdout; each is a
// record of the package's lib target, identified `['rust', <manifest>, 'doctest', <lib name>, <name>]`. Output and exit status are
// cargo's; a run that reported no doctest leaves no record, which the reconciliation reports as a target that ran no case.
//
//   MIXDOG_RECEIPT=<file> node scripts/ci/run-doctest.mjs -p <package> [more cargo test args]
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { packagesByName } from './coverage/adapters.mjs';
import { beginReceipt, finishReceipt, receiptPath } from './receipt.mjs';
import { readFileSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The records of libtest's output lines for the doctests of one lib target. */
export function doctestRecords(lines, manifest, lib) {
  const status = { ok: 'pass', FAILED: 'fail', ignored: 'ignored' };
  return lines.flatMap((line) => {
    const hit = /^test (.+) \.\.\. (ok|FAILED|ignored)\b/.exec(line);
    if (!hit) return [];
    const record = { kind: 'case', id: ['rust', manifest, 'doctest', lib, hit[1]], status: status[hit[2]] };
    return [hit[2] === 'ignored' ? { ...record, reasonCode: 'doctest-ignored', reasonText: '' } : record];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const name = args[args.findIndex((arg) => arg === '-p' || arg === '--package') + 1];
  if (!name) {
    console.error('usage: run-doctest.mjs -p <package> [cargo test args]');
    process.exit(2);
  }
  const env = { ...process.env };
  const receipt = receiptPath(env);
  delete env.MIXDOG_RECEIPT;
  delete env.MIXDOG_CHILD_RECEIPTS;
  if (receipt) beginReceipt(receipt, 'doctest');
  const lines = [];
  const child = spawn('cargo', ['test', '--doc', ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let rest = '';
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    const parts = (rest + chunk.toString('utf8')).split(/\r?\n/);
    rest = parts.pop();
    lines.push(...parts);
  });
  const status = await new Promise((done) => child.on('close', (code) => done(code ?? 1)));
  if (rest) lines.push(rest);
  if (receipt) {
    const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
      .stdout.split('\0')
      .filter(Boolean);
    const pkg = packagesByName(tracked, (path) => readFileSync(join(ROOT, path), 'utf8')).byName.get(name);
    const lib = pkg?.targets.find((target) => target.kind === 'lib');
    if (!lib) {
      console.error(`${name} has no tracked lib target: its doctests cannot be identified`);
      finishReceipt(receipt, 1);
      process.exit(1);
    }
    finishReceipt(receipt, status, { records: doctestRecords(lines, pkg.manifest, lib.name) });
  }
  process.exit(status);
}
