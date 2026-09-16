import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';
import {
  bundleElectronEntry,
  electronProcessEnv,
  spawnElectron,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';

await withTempWorkspace(
  'mixdog-browser-input-isolation-',
  async (directory) => {
    const output = join(directory, 'input-isolation.mjs');
    const log = join(directory, 'result.log');
    await Promise.all([
      build({
        entryPoints: [
          fileURLToPath(new URL('../src/renderer/test-support/browser-input-isolation.tsx', import.meta.url)),
        ],
        outfile: join(directory, 'fixture-renderer.js'),
        bundle: true,
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'warning',
      }),
      build({
        entryPoints: [
          fileURLToPath(new URL('../src/main/browser/test-fixtures/input-surface-preload.ts', import.meta.url)),
        ],
        outfile: join(directory, 'fixture-preload.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        logLevel: 'warning',
      }),
    ]);
    await bundleElectronEntry({
      entry: new URL('../src/main/browser/input-isolation.integration.ts', import.meta.url),
      outfile: output,
      plugins: [computerSourceEsbuildPlugin()],
      external: ['electron', 'ws'],
    });
    const env = electronProcessEnv({
      MIXDOG_INPUT_ISOLATION_DIRECTORY: directory,
      MIXDOG_INPUT_ISOLATION_LOG: log,
    });
    const child = spawnElectron(output, { env, args: process.argv.slice(2) });
    const code = await waitForChildExit(child, {
      timeoutMs: 120_000,
      onTimeout: 'kill',
      rejectOnSignal: false,
      fallbackCode: null,
    });
    const result = await readFile(log, 'utf8');
    process.stdout.write(result);
    if (code !== 0 || !result.includes('input isolation passed')) {
      throw new Error(`browser input isolation failed (exit ${code})`);
    }
  },
  { maxRetries: 10, retryDelay: 100 }
);
