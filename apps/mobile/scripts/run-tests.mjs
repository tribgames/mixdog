#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beginReceipt, childrenOf, finishReceipt, receiptPath } from '../../../scripts/ci/receipt.mjs';
import { DEFAULT_TEST_TIMEOUT_MS, LONG_TEST_TIMEOUT_MS, testTimeoutArg } from '../../../scripts/lib/run-node-tests.mjs';

const reporterUrl = (receipt) => {
  const url = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'ci', 'skip-reporter.mjs')
  );
  url.searchParams.set('out', receipt);
  return url.href;
};
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLOW = /\.slow\.test\.ts$/;

export function testFiles(lane, root = ROOT) {
  if (lane !== 'unit' && lane !== 'e2e') throw new Error(`lane must be unit or e2e, got ${lane}`);
  return readdirSync(join(root, 'src'), { recursive: true })
    .map((entry) => String(entry).split('\\').join('/'))
    .filter((entry) => entry.endsWith('.test.ts') && SLOW.test(entry) === (lane === 'e2e'))
    .sort()
    .map((entry) => `src/${entry}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = testFiles(process.argv[2]);
  if (!files.length) {
    console.error(`no ${process.argv[2]} test files under src/`);
    process.exit(1);
  }
  // With MIXDOG_RECEIPT (the gate sets it per lane) the run leaves a receipt the skip check reads: this lane's skips are reviewed like
  // every other Node lane's (scripts/ci/receipt.mjs); without it this is a plain run.
  const env = { ...process.env };
  const receipt = receiptPath(env);
  delete env.MIXDOG_RECEIPT;
  delete env.MIXDOG_CHILD_RECEIPTS;
  const reporting = receipt
    ? [
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        `--test-reporter=${reporterUrl(receipt)}`,
        '--test-reporter-destination=stdout',
      ]
    : [];
  if (receipt) {
    beginReceipt(receipt, 'node');
    env.MIXDOG_CHILD_RECEIPTS = childrenOf(receipt);
  }
  // As scripts/test.mjs: a handle left open no longer keeps a finished file alive, and a file that never finishes fails.
  const nodeArgs = ['--test-force-exit'];
  const timeout = testTimeoutArg(
    nodeArgs,
    env,
    process.argv[2] === 'unit' ? DEFAULT_TEST_TIMEOUT_MS : LONG_TEST_TIMEOUT_MS
  );
  if (timeout) nodeArgs.push(timeout);
  const run = spawnSync(process.execPath, ['--import', 'tsx', ...reporting, '--test', ...nodeArgs, ...files], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  const status = run.status ?? 1;
  if (receipt) finishReceipt(receipt, status);
  process.exit(status);
}
