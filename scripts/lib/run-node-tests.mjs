import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    const child = spawn(process.execPath, args, env ? { stdio: 'inherit', env } : { stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(error);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

// Both discovery and explicit-file runs use the same output contract. Node
// still owns test selection, diagnostics, skip/todo counts and exit status;
// a batched run keeps one full log and fails on the first failing batch.
//
// With `coverage`, every batch inherits one fresh NODE_V8_COVERAGE directory,
// so V8 writes a dump per test process into it and the batches fold into a
// single artifact. Without it nothing here changes — not the spawn options,
// not the environment, not the output.
export async function runNodeTests(nodeArgs, fileArgs, { argBudget = ARG_BUDGET, coverage = false } = {}) {
  const logPath = join(await mkdtemp(join(tmpdir(), 'mixdog-test-output-')), 'full.log');
  console.error(`Full test log: ${logPath}`);
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
  const env = coverageDir ? { ...process.env, NODE_V8_COVERAGE: coverageDir } : undefined;
  let status = 0;
  for (const [index, batch] of batches.entries()) {
    const batchLog = batches.length === 1 ? logPath : `${logPath}.${index + 1}`;
    const code = await spawnBatch([...runArgs, `--test-reporter-destination=${batchLog}`, ...batch], env);
    if (batchLog !== logPath) {
      await appendFile(logPath, await readFile(batchLog));
      await rm(batchLog, { force: true });
    }
    if (status === 0) status = code;
  }
  process.exitCode = status;
  if (coverageDir) {
    const { reportCoverage } = await import('./coverage.mjs');
    await reportCoverage(coverageDir);
    await rm(coverageDir, { recursive: true, force: true });
  }
}
