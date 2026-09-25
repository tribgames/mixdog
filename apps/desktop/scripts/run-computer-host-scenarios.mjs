import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { optionValue } from './cli-args.mjs';
import { repeatRequiresPass } from './computer-host-repeat-policy.mjs';
import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';
import { bundleElectronEntry, electronProcessEnv, spawnElectron, waitForChildExit } from './electron-harness.mjs';

const label = optionValue('label') || 'baseline';
const initialDirectory = process.env.INIT_CWD || process.cwd();
const reportPath = resolve(
  optionValue('output') || join(initialDirectory, 'artifacts', 'computer-use', `scenario-${label}.json`)
);
const requirePass = repeatRequiresPass();
// Foreground delivery takes the real pointer, so this lane lets the rest of the
// matrix run while someone is using the machine.
const skipForeground = process.argv.includes('--skip-foreground');
const only = optionValue('only');
const timeoutMs = Number(optionValue('timeout-ms')) || 900_000;
const staging = await mkdtemp(join(tmpdir(), 'mixdog-computer-host-scenarios-'));
const profile = await mkdtemp(join(tmpdir(), 'mixdog-computer-scenarios-profile-'));
const output = join(staging, 'computer-host-scenarios.mjs');
const progressPath = join(staging, 'progress.log');

try {
  await bundleElectronEntry({
    entry: new URL('../src/main/computer/harness/scenarios.ts', import.meta.url),
    outfile: output,
    plugins: [computerSourceEsbuildPlugin()],
    sourcemap: 'inline',
  });

  const env = electronProcessEnv({
    MIXDOG_COMPUTER_SCENARIO_LOG: progressPath,
    MIXDOG_COMPUTER_SCENARIO_REPORT: reportPath,
    MIXDOG_COMPUTER_SCENARIO_LABEL: label,
    MIXDOG_COMPUTER_SCENARIO_REPORT_DIR: dirname(reportPath),
    MIXDOG_COMPUTER_SCENARIO_ONLY: only,
    MIXDOG_COMPUTER_SCENARIO_SKIP_FOREGROUND: skipForeground ? '1' : '',
    MIXDOG_COMPUTER_SCENARIO_PROFILE: profile,
  });
  // --display=primary keeps every fixture on the primary display, so a failure
  // can be attributed to the code rather than to secondary-display geometry.
  env.MIXDOG_COMPUTER_SCENARIO_DISPLAY = optionValue('display');
  let emittedProgress = '';
  const flushProgress = () => {
    let progress = '';
    try {
      progress = readFileSync(progressPath, 'utf8');
    } catch {
      return;
    }
    const addition = progress.startsWith(emittedProgress) ? progress.slice(emittedProgress.length) : progress;
    if (addition) process.stdout.write(addition);
    emittedProgress = progress;
  };
  watchFile(progressPath, { interval: 500 }, flushProgress);
  const child = spawnElectron(output, { env });
  let timedOut = false;
  const exitCode = await waitForChildExit(child, {
    timeoutMs,
    onTimeout: 'kill',
    fallbackCode: 1,
    onTimedOut: () => {
      timedOut = true;
    },
    signalMessage: (signal) => `computer host scenario matrix was terminated by ${signal}`,
  });
  unwatchFile(progressPath);
  flushProgress();
  const progress = await readFile(progressPath, 'utf8').catch(() => '');
  if (timedOut) throw new Error(`computer host scenario matrix exceeded ${timeoutMs}ms`);
  if (exitCode !== 0 || !progress.includes('scenario matrix complete')) {
    throw new Error(`computer host scenario matrix failed before its completion marker (exit ${exitCode})`);
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  console.log(
    `Computer Use scenarios ${report.summary.passed}/${report.summary.total} passed` +
      ` (${report.summary.failed} failed, ${report.summary.skipped} skipped); ${reportPath}`
  );
  if (requirePass && report.summary.failed > 0) {
    throw new Error(`${report.summary.failed} Computer Use scenarios failed`);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  }).catch((error) => {
    console.warn(`computer scenario profile cleanup deferred: ${error.code || error.message}`);
  });
}
