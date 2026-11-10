// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// A spawn phase that reports success without leaving a child behind: the
// wiring below it (output capture, settle, deadlines) then throws. Inside an
// async Promise executor that throw reaches nobody, so before the fix the
// caller awaited execShellCommand forever. Mocked before the first import of
// shell-command.mjs, which is the module's only importer.
mock.module('./lib/shell-run-spawn.mjs', {
  namedExports: { spawnShellChild: async () => {} },
});

const { execShellCommand } = await import('./shell-command.mjs');

test('a wiring fault after spawn settles the run instead of hanging the caller', async () => {
  const releases = [];
  const admission = {
    async acquire() {
      return {
        signal: null,
        async detachDependency() {},
        async release() {
          releases.push('release');
        },
      };
    },
  };
  let hangTimer;
  const hang = new Promise((_, reject) => {
    hangTimer = setTimeout(() => reject(new Error('execShellCommand never settled')), 5_000);
  });
  try {
    const result = await Promise.race([
      execShellCommand({
        shell: process.execPath,
        shellArg: '',
        command: 'echo wiring-fault-regression',
        env: process.env,
        cwd: fixtureRoot,
        timeoutMs: 1_000,
        admission,
      }),
      hang,
    ]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.failurePhase, 'tool');
    assert.equal(result.failureReason, 'spawn failed');
    assert.ok(result.stderr.length > 0, 'the failure reaches the caller as stderr text');
    assert.deepEqual(releases, ['release'], 'the admission lease is not leaked by the failure path');
  } finally {
    clearTimeout(hangTimer);
  }
});
