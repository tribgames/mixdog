import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import test from 'node:test';
import { powershellHostProgram, ABORT_CLEANUP_PROGRAM } from './program.ts';
import { computerSourceEsbuildPlugin, computerSourceVitePlugin } from '../../../../scripts/computer-source-assets.mjs';

test('desktop and harness bundles carry the complete native program without source files beside them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-native-bundle-'));
  const entry = fileURLToPath(new URL('./program.ts', import.meta.url));
  const expected = powershellHostProgram();
  try {
    const esbuildOutput = join(directory, 'esbuild.mjs');
    await esbuild({
      entryPoints: [entry], outfile: esbuildOutput, bundle: true, platform: 'node', format: 'esm',
      external: ['electron'], plugins: [computerSourceEsbuildPlugin()], logLevel: 'silent',
    });
    const viteOutput = join(directory, 'vite.mjs');
    await viteBuild({
      configFile: false, plugins: [computerSourceVitePlugin()], logLevel: 'silent',
      build: {
        ssr: entry, outDir: dirname(viteOutput), emptyOutDir: false, minify: false,
        rollupOptions: { external: ['electron'], output: { format: 'es', entryFileNames: 'vite.mjs' } },
      },
    });
    for (const output of [esbuildOutput, viteOutput]) {
      const bundled = await import(pathToFileURL(output).href);
      assert.equal(bundled.powershellHostProgram(), expected);
      assert.equal(bundled.ABORT_CLEANUP_PROGRAM, ABORT_CLEANUP_PROGRAM);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
