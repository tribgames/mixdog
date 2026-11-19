import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import electron from 'electron';

const execFileAsync = promisify(execFile);

test('Web Push signing and verification work in Electron Node mode', { timeout: 30_000 }, async () => {
  const testFile = fileURLToPath(new URL('../../../relay/lib/web-push.test.mjs', import.meta.url));
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  // The assertions are the child suite's, so its result counts: scripts/ci/node-runner.mjs gives it a receipt of its own (the gate's skip
  // check reads it) when the lane left a children folder in MIXDOG_CHILD_RECEIPTS, and is a plain `--test` run otherwise.
  const runner = fileURLToPath(new URL('../../../../scripts/ci/node-runner.mjs', import.meta.url));
  const { stderr } = await execFileAsync(electron, [runner, '--import', 'tsx', testFile], {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    maxBuffer: 1024 * 1024,
    timeout: 25_000,
    windowsHide: true,
  });
  assert.doesNotMatch(stderr, /NO_DEFAULT_DIGEST/u);
});
