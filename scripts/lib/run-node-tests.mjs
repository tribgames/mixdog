import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAILURE_RECORDS_ENV } from './test-failure-records.mjs';
import { classifyRerunOutcomes, formatFailureSummary } from './test-failure-summary.mjs';

const SUMMARY_REPORTER = new URL('./test-summary-reporter.mjs', import.meta.url).href;

// A whole-suite run passes ~700 paths to one node process. Windows caps a
// command line at 32767 characters (CreateProcess) and POSIX caps argv+env at
// ARG_MAX, so the file list is spawned in batches that stay under the cap
// instead of dying with spawn ENAMETOOLONG before any test runs.
export const ARG_BUDGET = process.platform === 'win32' ? 30_000 : 1_000_000;

// An argument costs its own characters plus the separator and its quotes.
const argCost = (arg) => arg.length + 3;

// Batches keep the file order Node was given; a single path larger than the
// budget still gets its own batch rather than being dropped. An empty list
// stays one batch: Node's own discovery is what an argument-less run means.
export function chunkFileArgs(fileArgs, budget) {
  const chunks = [[]];
  let cost = 0;
  for (const file of fileArgs) {
    const current = chunks.at(-1);
    if (current.length > 0 && cost + argCost(file) > budget) {
      chunks.push([file]);
      cost = argCost(file);
      continue;
    }
    current.push(file);
    cost += argCost(file);
  }
  return chunks;
}

function spawnBatch(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env });
    child.on('error', (error) => {
      console.error(error);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

// The failure reporter writes one JSON line per failed test; a spawn that
// died before Node opened its destination leaves no file at all.
async function readFailureRecords(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Both discovery and explicit-file runs use the same output contract. Node
// still owns test selection, diagnostics, skip/todo counts and exit status;
// a batched run keeps one full log and fails on the first failing batch.
//
// With `coverage`, every batch inherits one fresh NODE_V8_COVERAGE directory,
// so V8 writes a dump per test process into it and the batches fold into a
// single artifact. Without it nothing here changes — not the spawn options,
// not the environment, not the output.
//
// `rerunFailed` (default 0 = off) re-runs the files that failed, up to n
// times. A test that passes on a re-run is reported as flaky and, because the
// flag was passed, does not fail the run; a test that fails every re-run
// still exits 1. Every run ends with the failure summary block, so a filtered
// log can still name what failed.
export async function runNodeTests(
  nodeArgs,
  fileArgs,
  { argBudget = ARG_BUDGET, coverage = false, rerunFailed = 0 } = {}
) {
  const logPath = join(await mkdtemp(join(tmpdir(), 'mixdog-test-output-')), 'full.log');
  console.error(`Full test log: ${logPath}`);
  // Failure records live outside the log directory: the log directory holds
  // exactly one merged log, and these records are an internal artifact.
  const failureDir = await mkdtemp(join(tmpdir(), 'mixdog-test-failures-'));
  const runArgs = [
    ...nodeArgs,
    `--test-reporter=${SUMMARY_REPORTER}`,
    '--test-reporter-destination=stdout',
    '--test-reporter=spec',
  ];
  const fixedCost =
    argCost(process.execPath) +
    runArgs.reduce((total, arg) => total + argCost(arg), 0) +
    argCost(`--test-reporter-destination=${logPath}`) +
    argCost('.999'); // the per-batch log suffix
  const batches = chunkFileArgs(fileArgs, Math.max(argBudget - fixedCost, 1));
  const coverageDir = coverage ? await mkdtemp(join(tmpdir(), 'mixdog-v8-coverage-')) : '';
  // Failure records travel by environment, not argv: the command line is
  // already budgeted, and a third reporter would warn about listeners.
  const childEnv = (recordsPath) => ({
    ...process.env,
    [FAILURE_RECORDS_ENV]: recordsPath,
    ...(coverageDir ? { NODE_V8_COVERAGE: coverageDir } : {}),
  });
  let status = 0;
  const failures = [];
  for (const [index, batch] of batches.entries()) {
    const batchLog = batches.length === 1 ? logPath : `${logPath}.${index + 1}`;
    const batchFailures = join(failureDir, `batch-${index + 1}.jsonl`);
    const code = await spawnBatch(
      [...runArgs, `--test-reporter-destination=${batchLog}`, ...batch],
      childEnv(batchFailures)
    );
    if (batchLog !== logPath) {
      await appendFile(logPath, await readFile(batchLog));
      await rm(batchLog, { force: true });
    }
    failures.push(...(await readFailureRecords(batchFailures)));
    if (status === 0) status = code;
  }

  const attempts = [];
  let lastAttemptStatus = 0;
  let pending = failures;
  for (let attempt = 1; attempt <= rerunFailed && pending.length > 0; attempt += 1) {
    const files = [...new Set(pending.map((record) => record.file))];
    console.error(`Re-running ${files.length} failed file(s): attempt ${attempt}/${rerunFailed}`);
    const attemptLog = `${logPath}.rerun-${attempt}`;
    const attemptFailures = join(failureDir, `rerun-${attempt}.jsonl`);
    lastAttemptStatus = await spawnBatch(
      [...runArgs, `--test-reporter-destination=${attemptLog}`, ...files],
      childEnv(attemptFailures)
    );
    await appendFile(logPath, await readFile(attemptLog));
    await rm(attemptLog, { force: true });
    attempts.push({ files, failures: await readFailureRecords(attemptFailures) });
    pending = classifyRerunOutcomes(failures, attempts).failed;
  }
  const { failed, flaky } = classifyRerunOutcomes(failures, attempts);
  // Flaky tolerance applies only to an ordinary test-failure exit that the
  // re-runs fully explained: nothing failed twice and the last re-run itself
  // came back clean.
  if (rerunFailed > 0 && status === 1 && failed.length === 0 && flaky.length > 0 && lastAttemptStatus === 0) status = 0;
  process.exitCode = status;

  await rm(failureDir, { recursive: true, force: true });
  if (coverageDir) {
    const { reportCoverage } = await import('./coverage.mjs');
    await reportCoverage(coverageDir);
    await rm(coverageDir, { recursive: true, force: true });
  }
  // Last line of the run, after every reporter and the coverage report.
  process.stdout.write(`\n${formatFailureSummary({ failed, flaky, rerunFailed })}`);
}
