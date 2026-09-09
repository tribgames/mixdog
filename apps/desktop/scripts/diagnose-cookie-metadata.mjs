// Read-only source inspection; exercise Chromium validation in an isolated profile.
// Cookie values are never read from Chrome or printed.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import electron from 'electron';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'mixdog-cookie-diagnosis-'));
try {
  const output = join(directory, 'diagnosis.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./diagnose-cookie-metadata.ts', import.meta.url))],
    outfile: output, bundle: true, platform: 'node', format: 'esm',
    target: 'node22', external: ['electron'],
  });
  const env = { ...process.env, MIXDOG_COOKIE_DIAGNOSIS_ROOT: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [output, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
