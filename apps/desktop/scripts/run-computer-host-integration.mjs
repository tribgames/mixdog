import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
import { build } from 'esbuild';

const staging = await mkdtemp(join(tmpdir(), 'mixdog-computer-host-integration-'));
const output = join(staging, 'computer-host-integration.mjs');
const progressPath = join(staging, 'progress.log');

try {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/main/computer/harness/integration.ts', import.meta.url))],
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
  env.MIXDOG_COMPUTER_INTEGRATION_LOG = progressPath;
  const child = spawn(electron, [output], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('computer host integration exceeded 120 seconds'));
    }, 120_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`computer host integration was terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  const progress = await readFile(progressPath, 'utf8').catch(() => '');
  if (progress) process.stdout.write(progress);
  if (exitCode !== 0 || !progress.includes('integration passed')) {
    throw new Error(`computer host integration failed before its success marker (exit ${exitCode})`);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
