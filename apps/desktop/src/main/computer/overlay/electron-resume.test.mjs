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

async function runFixture(name) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-overlay-ipc-'));
  try {
    await Promise.all([
      build({ entryPoints: [fileURLToPath(new URL(`./test-fixtures/${name}.ts`, import.meta.url))],
        bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
        outfile: join(directory, 'main/index.cjs') }),
      build({ entryPoints: [fileURLToPath(new URL('../../../preload/computer-overlay.ts', import.meta.url))],
        bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
        outfile: join(directory, 'preload/computer-overlay.js') }),
    ]);
    const env = { ...process.env, OVERLAY_TEST_DIRECTORY: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [join(directory, 'main/index.cjs')], {
      env, windowsHide: true, timeout: 20000,
    });
    return JSON.parse(stdout.split('OVERLAY_RESULT ')[1].split('\n')[0]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// The overlay belongs to Computer Use, which ships on Windows only; the Linux CI lanes also have no display server.
test('sandboxed overlay preserves native Stop hit-testing, non-activation and preload IPC', { timeout: 30000, skip: process.platform !== 'win32' }, async () => {
  const result = await runFixture('electron-resume');
  assert.equal(result.resumed, 1);
  assert.equal(result.stopped, 2);
  assert.equal(result.visible, false);
  console.log('overlay IPC evidence', result);
});

test('a frozen real renderer is retired and native Dismiss closes its replacement without enabling input', { timeout: 30000, skip: process.platform !== 'win32' }, async () => {
  const result = await runFixture('electron-recovery');
  assert.deepEqual(result, { retired: true, visible: false, inputBlocked: true, resumed: 0 });
  console.log('overlay renderer recovery evidence', result);
});
