import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUMMARY_REPORTER = new URL('./test-summary-reporter.mjs', import.meta.url).href;

// Both discovery and explicit-file runs use the same output contract. Node
// still owns test selection, diagnostics, skip/todo counts and exit status.
export async function runNodeTests(nodeArgs, fileArgs) {
  const logPath = join(await mkdtemp(join(tmpdir(), 'mixdog-test-output-')), 'full.log');
  console.error(`Full test log: ${logPath}`);
  const child = spawn(process.execPath, [
    ...nodeArgs,
    `--test-reporter=${SUMMARY_REPORTER}`,
    '--test-reporter-destination=stdout',
    '--test-reporter=spec',
    `--test-reporter-destination=${logPath}`,
    ...fileArgs,
  ], { stdio: 'inherit' });
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
