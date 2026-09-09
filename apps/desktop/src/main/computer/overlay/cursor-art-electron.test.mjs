import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import electron from 'electron';

test('Electron renders only a click effect at the hotspot, without a second pointer or text', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-cursor-art-'));
  try {
    const main = join(directory, 'main.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('./test-fixtures/cursor-art.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: main });
    const env = { ...process.env, CURSOR_TEST_DIRECTORY: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(electron, [main], { env, windowsHide: true, timeout: 20000 });
    assert.match(result.stdout, /CURSOR_ART_OK/);
    console.log(result.stdout.trim());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('live overlay preparation, display positioning and takeover cleanup preserve the user desktop', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-cursor-lifecycle-'));
  try {
    const main = join(directory, 'main.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('./test-fixtures/cursor-lifecycle.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: main });
    const env = { ...process.env, CURSOR_TEST_DIRECTORY: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(electron, [main], { env, windowsHide: true, timeout: 20000 });
    assert.match(result.stdout, /CURSOR_LIFECYCLE_OK/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
