import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
import { build } from 'esbuild';

const staging = await mkdtemp(join(tmpdir(), 'mixdog-browser-profile-import-integration-'));
const output = join(staging, 'browser-profile-import-integration.mjs');

try {
  await build({
    entryPoints: [
      fileURLToPath(new URL('../src/main/browser/profile-import.integration.ts', import.meta.url)),
    ],
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
  env.MIXDOG_BROWSER_PROFILE_IMPORT_TEST_ROOT = join(staging, 'profile');
  const child = spawn(electron, [output], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('browser profile import integration exceeded 30 seconds'));
    }, 30_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`browser profile import integration was terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`browser profile import integration failed (exit ${exitCode})`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
