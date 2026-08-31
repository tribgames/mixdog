import { spawn } from 'node:child_process';
import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
import { build } from 'esbuild';

const argument = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
};

const label = argument('label') || 'baseline';
const initialDirectory = process.env.INIT_CWD || process.cwd();
const reportPath = resolve(
  argument('output') || join(initialDirectory, 'artifacts', 'computer-use', `scenario-${label}.json`),
);
const requirePass = process.argv.includes('--require-pass');
const only = argument('only');
const timeoutMs = Number(argument('timeout-ms')) || 900_000;
const staging = await mkdtemp(join(tmpdir(), 'mixdog-computer-host-scenarios-'));
const profile = await mkdtemp(join(tmpdir(), 'mixdog-computer-scenarios-profile-'));
const output = join(staging, 'computer-host-scenarios.mjs');
const progressPath = join(staging, 'progress.log');

try {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/main/computer-host.scenarios.ts', import.meta.url))],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
    sourcemap: 'inline',
    logLevel: 'warning',
  });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.MIXDOG_COMPUTER_SCENARIO_LOG = progressPath;
  env.MIXDOG_COMPUTER_SCENARIO_REPORT = reportPath;
  env.MIXDOG_COMPUTER_SCENARIO_LABEL = label;
  env.MIXDOG_COMPUTER_SCENARIO_REPORT_DIR = dirname(reportPath);
  env.MIXDOG_COMPUTER_SCENARIO_ONLY = only;
  env.MIXDOG_COMPUTER_SCENARIO_PROFILE = profile;
  // --display=primary keeps every fixture on the primary display, so a failure
  // can be attributed to the code rather than to secondary-display geometry.
  env.MIXDOG_COMPUTER_SCENARIO_DISPLAY = argument('display');
  let emittedProgress = '';
  const flushProgress = () => {
    let progress = '';
    try {
      progress = readFileSync(progressPath, 'utf8');
    } catch {
      return;
    }
    const addition = progress.startsWith(emittedProgress)
      ? progress.slice(emittedProgress.length)
      : progress;
    if (addition) process.stdout.write(addition);
    emittedProgress = progress;
  };
  watchFile(progressPath, { interval: 500 }, flushProgress);
  const child = spawn(electron, [output], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  let timedOut = false;
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal && !timedOut) reject(new Error(`computer host scenario matrix was terminated by ${signal}`));
      else resolveExit(code ?? (timedOut ? 124 : 1));
    });
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
    `Computer Use scenarios ${report.summary.passed}/${report.summary.total} passed`
      + ` (${report.summary.failed} failed, ${report.summary.skipped} skipped); ${reportPath}`,
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
