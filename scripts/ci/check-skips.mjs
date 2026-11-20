#!/usr/bin/env node
// The per-job early check of a lane's receipts (the aggregate proof is scripts/ci/coverage/reconcile.mjs, docs/testing.md, "Release
// coverage"). It exists so a job that skipped something unreviewed fails where it ran, and so a pull request, which has no full
// reconciliation, still fails an unreviewed skip. It credits nothing: it never decides that a test ran, and it does not look at a
// listing or a profile. Two things are checked and both fail closed:
//
//   1. Every named receipt exists and is intact evidence (scripts/ci/receipt.mjs): complete, exit 0, the trailer binds its records.
//      A receipt not named is not expected, and one named that is absent is an invocation that did not run.
//   2. Every skipped, todo or ignored observation has an exact reviewed exception (scripts/ci/coverage/exceptions.json) for its case,
//      this platform, its kind and its reason code. A skipped suite has no exception form (its children are never reported), so it fails.
//
//   node scripts/ci/check-skips.mjs receipts <receipt.json>...      (`--strict`: no skip at all, for an invocation that checks what a
//                                                                     prepared environment holds)
//   node scripts/ci/check-skips.mjs matches <list.json>             exit 0 when the nextest list has a test that matches its filter
//                                                                     (a step that runs a filter only where its crate is built)
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { OS_OF, allows, loadExceptions } from './coverage/exceptions.mjs';
import { loadPlan } from './coverage/plan.mjs';
import { readReceipts, receiptProblems } from './receipt.mjs';

const observedOf = (record, platform, slot) => ({
  id: record.id,
  platform,
  slot,
  kind:
    record.status === 'ignored' ? 'ignored' : record.status === 'todo' || record.status === 'xfail' ? 'todo' : 'skip',
  reasonCode: record.reasonCode ?? 'uncoded',
  reasonText: record.reasonText ?? '',
});

/** The problems of a set of receipts: each is intact, none shares an invocation id, every skip has an exact exception. */
export function receiptsProblems(paths, exceptions, platform = process.platform, { strict = false } = {}) {
  const problems = [];
  const ids = new Map();
  const os = OS_OF[platform] ?? platform;
  for (const { path, receipt, problem } of readReceipts(paths)) {
    if (problem) {
      problems.push(`${path}: ${problem}`);
      continue;
    }
    for (const text of receiptProblems(receipt)) problems.push(`${path}: the receipt ${text}`);
    if (receipt.id) {
      if (ids.has(receipt.id))
        problems.push(
          `${path}: the receipt id ${receipt.id} is also the id of ${ids.get(receipt.id)}: a receipt is not reused`
        );
      else ids.set(receipt.id, path);
    }
    if (receipt.platform && receipt.platform !== platform)
      problems.push(`${path}: the receipt is from ${receipt.platform}, this check runs on ${platform}`);
    for (const record of receipt.records ?? []) {
      if (record.status === 'fail' || record.status === 'cancelled')
        problems.push(`${path}: ${JSON.stringify(record.id)} ${record.status}`);
      if (record.status === 'pass') continue;
      if (record.status === 'fail' || record.status === 'cancelled') continue;
      const where = `${path}: ${record.kind} ${JSON.stringify(record.id)} ${record.status}${record.reasonText ? ` (${record.reasonText})` : ''}`;
      if (strict) problems.push(`${where} where no skip is accepted`);
      else if (record.kind === 'suite')
        problems.push(`${where}: a skipped suite has no reviewed exception: skip its cases, not the suite`);
      else if (!exceptions.exceptions.some((tuple) => allows(tuple, observedOf(record, os, receipt.envelope?.slot))))
        problems.push(`${where} on ${os} has no reviewed exception`);
    }
  }
  return problems;
}

/** The number of tests of a nextest list that match its filter. */
export function matchingTests(list) {
  if (!list || typeof list['rust-suites'] !== 'object') throw new Error('not a nextest list: no "rust-suites"');
  let count = 0;
  for (const suite of Object.values(list['rust-suites']))
    for (const test of Object.values(suite.testcases ?? {})) if (test['filter-match']?.status === 'matches') count += 1;
  return count;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  const args = process.argv.slice(2);
  const strictAt = args.indexOf('--strict');
  const strict = strictAt >= 0 && args.splice(strictAt, 1).length === 1;
  const [mode, file, ...rest] = args;
  if (mode === 'matches' && file) process.exit(matchingTests(JSON.parse(readFileSync(file, 'utf8'))) > 0 ? 0 : 1);
  if (mode !== 'receipts' || !file) {
    console.error('usage: check-skips.mjs receipts [--strict] <receipt.json>... | matches <list.json>');
    process.exit(2);
  }
  const problems = receiptsProblems([file, ...rest], loadExceptions(loadPlan()), process.platform, { strict });
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(
      `${problems.length} problem(s): a missing or damaged receipt, or a skip with no exact reviewed exception (scripts/ci/coverage/exceptions.json; docs/testing.md)`
    );
    process.exit(1);
  }
  console.log('check-skips receipts: ok');
}
