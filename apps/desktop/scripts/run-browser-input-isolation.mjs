import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';
import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';

const directory = await mkdtemp(join(tmpdir(), 'mixdog-browser-input-isolation-'));
const output = join(directory, 'input-isolation.mjs');
const log = join(directory, 'result.log');
try {
  await Promise.all([
    build({
      entryPoints: [fileURLToPath(new URL('../src/renderer/test-support/browser-input-isolation.tsx', import.meta.url))],
      outfile: join(directory, 'fixture-renderer.js'), bundle: true, platform: 'browser',
      format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
    }),
    build({
      entryPoints: [fileURLToPath(new URL('../src/main/browser/test-fixtures/input-surface-preload.ts', import.meta.url))],
      outfile: join(directory, 'fixture-preload.cjs'), bundle: true, platform: 'node',
      format: 'cjs', external: ['electron'], logLevel: 'warning',
    }),
  ]);
  await build({
    entryPoints: [fileURLToPath(new URL('../src/main/browser/input-isolation.integration.ts', import.meta.url))],
    outfile: output,
    bundle: true,
    plugins: [computerSourceEsbuildPlugin()],
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron', 'ws'],
    logLevel: 'warning',
  });
  const env = { ...process.env, MIXDOG_INPUT_ISOLATION_DIRECTORY: directory, MIXDOG_INPUT_ISOLATION_LOG: log };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [output, ...process.argv.slice(2)], {
    env, stdio: 'inherit', windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
    }, 120_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  const result = await readFile(log, 'utf8');
  process.stdout.write(result);
  if (code !== 0 || !result.includes('input isolation passed')) {
    throw new Error(`browser input isolation failed (exit ${code})`);
  }
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
