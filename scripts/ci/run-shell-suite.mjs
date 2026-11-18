#!/usr/bin/env node
// Runs a shell test file that reports `ok: <scenario>` / `FAIL: <scenario>: <text>` lines with bash and leaves the receipt
// of the invocation (scripts/ci/receipt.mjs). The file is a terminal-only format: a case is a pass only when the file reported it finished
// (`ok: <scenario>`) and no check of it failed (`FAIL: <scenario>: <text>`); a case it did not report gets no record, and a file that reported none
// ran no case, which the reconciliation reports. Output passes through unchanged; the exit status is bash's.
//
//   MIXDOG_RECEIPT=<file> node scripts/ci/run-shell-suite.mjs <file.test.sh>
import { spawn } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beginReceipt, finishReceipt, receiptPath } from './receipt.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Terminal records of one run's output lines (stdout and stderr, whose relative order is not kept), in the order the cases finished. A
 * case's failed checks are matched by its name over the whole output, never by position.
 */
export function shellRecords(file, lines) {
  const failed = new Map();
  for (const line of lines) {
    const fail = /^FAIL: ([^:\s]+): (.*)$/.exec(line);
    if (fail) failed.set(fail[1], [...(failed.get(fail[1]) ?? []), fail[2]]);
  }
  const records = [];
  for (const line of lines) {
    const ok = /^ok: (\S+)$/.exec(line);
    if (!ok) continue;
    const id = ['shell', file, ok[1]];
    const reasons = failed.get(ok[1]);
    records.push(reasons ? { kind: 'case', id, status: 'fail', reasonText: reasons.join('; ') } : { kind: 'case', id, status: 'pass' });
  }
  return records;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [script] = process.argv.slice(2);
  if (!script) {
    console.error('usage: run-shell-suite.mjs <file.test.sh>');
    process.exit(2);
  }
  const env = { ...process.env };
  const receipt = receiptPath(env);
  delete env.MIXDOG_RECEIPT;
  delete env.MIXDOG_CHILD_RECEIPTS;
  if (receipt) beginReceipt(receipt, 'shell');
  const file = relative(ROOT, resolve(script)).split(sep).join('/');
  const child = spawn('bash', [resolve(script)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let rest = '';
    stream.on('data', (chunk) => {
      out.write(chunk);
      const text = rest + chunk.toString('utf8');
      const parts = text.split(/\r?\n/);
      rest = parts.pop();
      lines.push(...parts);
    });
    stream.on('end', () => rest && lines.push(rest));
  }
  const status = await new Promise((done) => child.on('close', (code) => done(code ?? 1)));
  if (receipt) finishReceipt(receipt, status, { records: shellRecords(file, lines) });
  process.exit(status);
}
