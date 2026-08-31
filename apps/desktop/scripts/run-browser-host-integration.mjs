import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
import { build } from 'esbuild';

const staging = await mkdtemp(join(tmpdir(), 'mixdog-browser-host-integration-'));
const output = join(staging, 'browser-host-integration.mjs');
const progressPath = join(staging, 'progress.log');
let progressPrinted = false;

try {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/main/browser-host.integration.ts', import.meta.url))],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron', 'ws'],
    sourcemap: 'inline',
    logLevel: 'warning',
  });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.MIXDOG_BROWSER_INTEGRATION_LOG = progressPath;
  env.MIXDOG_BROWSER_MAX_ACTIONS_PER_TURN = '10';
  const child = spawn(electron, [output], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('browser host integration exceeded 90 seconds'));
    }, 90_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`browser host integration was terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  const progress = await readFile(progressPath, 'utf8').catch(() => '');
  if (progress) {
    process.stdout.write(progress);
    progressPrinted = true;
  }
  if (exitCode !== 0 || !progress.includes('integration passed')) {
    throw new Error(`browser host integration failed before its success marker (exit ${exitCode})`);
  }
} finally {
  const progress = await readFile(progressPath, 'utf8').catch(() => '');
  if (progress && !progressPrinted) {
    process.stderr.write(progress);
  }
  await rm(staging, { recursive: true, force: true });
}
