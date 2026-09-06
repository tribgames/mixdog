import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import electron from 'electron';

const execFileAsync = promisify(execFile);

test('Web Push signing and verification work in Electron Node mode', { timeout: 30_000 }, async () => {
  const testFile = fileURLToPath(new URL('./web-push.test.mjs', import.meta.url));
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  const { stderr } = await execFileAsync(
    electron,
    ['--import', 'tsx', '--test', testFile],
    {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      maxBuffer: 1024 * 1024,
      timeout: 25_000,
      windowsHide: true,
    },
  );
  assert.doesNotMatch(stderr, /NO_DEFAULT_DIGEST/u);
});
