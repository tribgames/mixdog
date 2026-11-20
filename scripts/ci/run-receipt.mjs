#!/usr/bin/env node
// Runs Python's unittest through the structured runner (scripts/ci/coverage/py-runner.py) and leaves the receipt of the invocation
// (scripts/ci/receipt.mjs): one record per terminal case or fixture suite with its identity and the skip reason as data. Output and exit
// status are the runner's. Without MIXDOG_RECEIPT the command runs as it is.
//
//   MIXDOG_RECEIPT=<file> node scripts/ci/run-receipt.mjs unittest <start-dir> <pattern>
//
// Standalone Rust crates run through scripts/ci/run-nextest.mjs, which reads nextest's own report; no output text is parsed here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { appendPart, beginReceipt, finishReceipt, receiptPath } from './receipt.mjs';

const RUNNER = fileURLToPath(new URL('./coverage/py-runner.py', import.meta.url));

/** The records of the runner's evidence file: JSON lines, the reason a JSON string whatever quotes it holds. */
export function readEvidence(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, startDir, pattern] = process.argv.slice(2);
  if (mode !== 'unittest' || !startDir || !pattern) {
    console.error('usage: run-receipt.mjs unittest <start-dir> <pattern>');
    process.exit(2);
  }
  const env = { ...process.env };
  const receipt = receiptPath(env);
  delete env.MIXDOG_RECEIPT;
  delete env.MIXDOG_CHILD_RECEIPTS;
  const scratch = mkdtempSync(join(tmpdir(), 'mixdog-py-evidence-'));
  const evidence = join(scratch, 'records.ndjson');
  env.MIXDOG_PY_EVIDENCE = evidence;
  if (receipt) beginReceipt(receipt, 'unittest');
  const run = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [RUNNER, '--start-dir', startDir, '--pattern', pattern],
    { stdio: 'inherit', env }
  );
  const status = run.status ?? 1;
  if (receipt) {
    let text = '';
    try {
      text = readFileSync(evidence, 'utf8');
    } catch {
      /* a runner that died before opening its file leaves no records: the receipt then holds none and the reconciler reports the leg's cases missing */
    }
    appendPart(receipt, { records: readEvidence(text) });
    finishReceipt(receipt, status);
  }
  rmSync(scratch, { recursive: true, force: true });
  process.exit(status);
}
