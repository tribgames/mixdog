#!/usr/bin/env node
// `node --test <args>` with the skip reporter beside the default spec reporter, for the lanes that call node directly instead of through
// scripts/test.mjs (the Rust core's script suites, the protocol client's suite, a real child suite a test starts). With a receipt
// (MIXDOG_RECEIPT, or MIXDOG_CHILD_RECEIPTS when a parent run left a children folder) it creates the receipt before the run and closes it
// after (scripts/ci/receipt.mjs); without either this is plain `node --test`. Exit status and output are node's.
//
// Usage: node scripts/ci/node-runner.mjs [node options] <test files...>
import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { beginReceipt, childrenOf, finishReceipt, parentOf, receiptPath } from './receipt.mjs';

export function nodeTestArgs(args, env = process.env) {
  const out = env.MIXDOG_RECEIPT;
  if (!out) return ['--test', ...args];
  const reporter = pathToFileURL(resolve(import.meta.dirname, 'skip-reporter.mjs'));
  reporter.searchParams.set('out', resolve(out));
  return [
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${reporter.href}`,
    '--test-reporter-destination=stdout',
    '--test',
    ...args,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = { ...process.env };
  // A runner a test started finds only the parent's children folder: it is a named child slot of the parent's invocation (the files
  // it runs), declared in the routing plan, so a parent that passes without launching it leaves a missing slot.
  const child = !env.MIXDOG_RECEIPT && Boolean(env.MIXDOG_CHILD_RECEIPTS);
  const parent = child ? parentOf(env.MIXDOG_CHILD_RECEIPTS) : null;
  const receipt = receiptPath(env);
  delete env.MIXDOG_RECEIPT;
  delete env.MIXDOG_CHILD_RECEIPTS;
  // started by a test, this is a runner of its own: inside the parent's test context node would run the files as part of it and no
  // reporter of this run would see them
  delete env.NODE_TEST_CONTEXT;
  if (receipt) {
    const files = process.argv
      .slice(2)
      .filter((arg, index, all) => /\.(?:mjs|cjs|js|ts|tsx)$/.test(arg) && all[index - 1] !== '--import')
      .map((arg) =>
        relative(resolve(import.meta.dirname, '..', '..'), resolve(arg))
          .split(sep)
          .join('/')
      );
    beginReceipt(receipt, 'node', child ? { slot: `child:${files.sort().join(' ')}`, parent } : {});
    env.MIXDOG_RECEIPT = receipt;
  }
  const args = nodeTestArgs(process.argv.slice(2), env);
  // The tests do not inherit this run's receipt (it is not theirs to write); a runner one of them starts for a suite whose result counts
  // is given a children folder of its own through this variable, and a fixture runner that does not look for it stays isolated.
  delete env.MIXDOG_RECEIPT;
  if (receipt) env.MIXDOG_CHILD_RECEIPTS = childrenOf(receipt);
  const run = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  const status = run.status ?? 1;
  if (receipt) finishReceipt(receipt, status);
  process.exit(status);
}
