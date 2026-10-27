import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import electron from 'electron';

const execFileAsync = promisify(execFile);

// The daemon runs as ELECTRON_RUN_AS_NODE; on Linux the native sharp addon
// segfaults there, so a pasted image used to restart the daemon.
test('sharp resizes images in Electron Node mode once the daemon redirect is loaded', {
  timeout: 60_000,
  skip: process.platform !== 'linux',
}, async () => {
  const hook = new URL('../../../../src/runtime/shared/sharp-electron-linux.mjs', import.meta.url).href;
  const script = `
      await import(${JSON.stringify(hook)});
      const { default: sharp } = await import('sharp');
      const png = await sharp({ create: { width: 2400, height: 1600, channels: 4, background: '#abcdef' } }).png().toBuffer();
      const jpeg = await sharp(png).resize(1568, 1568, { fit: 'inside' }).jpeg().toBuffer();
      const meta = await sharp(jpeg).metadata();
      console.log(JSON.stringify({ width: meta.width, height: meta.height, format: meta.format }));
    `;
  const { stdout } = await execFileAsync(electron, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
    maxBuffer: 1024 * 1024,
    timeout: 55_000,
  });
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), { width: 1568, height: 1045, format: 'jpeg' });
});
