import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';

const staging = await mkdtemp(join(tmpdir(), 'mixdog-cookie-persistence-'));
const entry = join(staging, 'cookie-persistence.mjs');
try {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/main/browser/profile-import-persistence.integration.ts', import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
    logLevel: 'warning',
  });
  for (const phase of ['write', 'read']) {
    const env = {
      ...process.env,
      MIXDOG_COOKIE_PERSISTENCE_TEST_ROOT: join(staging, 'profile'),
      MIXDOG_COOKIE_PERSISTENCE_TEST_PHASE: phase,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [entry], { env, stdio: 'inherit', windowsHide: true });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Cookie persistence ${phase} exceeded 30 seconds`));
      }, 30_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (status, signal) => {
        clearTimeout(timer);
        if (signal) reject(new Error(`Cookie persistence ${phase} terminated by ${signal}`));
        else resolve(status ?? 1);
      });
    });
    if (code !== 0) throw new Error(`Cookie persistence ${phase} failed (exit ${code})`);
  }
} finally {
  await rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
