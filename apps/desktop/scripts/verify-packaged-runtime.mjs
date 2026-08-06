import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import electron from 'electron';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(desktopDir, '../..');
const runtimeRoot = join(desktopDir, '.runtime', 'runtime.asar');
const verifier = join(rootDir, 'scripts', 'verify-embedding-runtime.mjs');

await Promise.all([access(runtimeRoot), access(verifier)]);

const child = spawn(electron, [
  verifier,
  '--core',
  `--runtime-root=${runtimeRoot}`,
], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  },
  stdio: 'inherit',
  windowsHide: true,
});

const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) {
      reject(new Error(`Packaged runtime verifier terminated by ${signal}.`));
      return;
    }
    resolveExit(code ?? 1);
  });
});

if (exitCode !== 0) {
  throw new Error(`Packaged runtime verifier exited with code ${exitCode}.`);
}
