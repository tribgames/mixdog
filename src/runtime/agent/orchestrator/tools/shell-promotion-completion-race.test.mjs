// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { holdWorkspaceActivity } from '../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../shared/worktrees/test-support.mjs';

// The spawn server releases a foreground task's record when it exits, so a
// promotion that loses the race to completion fails with "no native task
// record". The fake promotion fails that way once the child has reached
// `finishedAt` ('exit', or 'close' after the run's own close handler).
let finishedAt = 'close';
let real = null;
mock.module('./lib/shell-run-background/promote-job.mjs', {
  namedExports: {
    promoteWithRetry: async ({ run }) => {
      await new Promise((done) => run.child.once(finishedAt, done));
      return { job: null, promotionFailure: `no native task record for jobId ${run.foregroundRecordId}` };
    },
    handOverLease: (...args) => real.handOverLease(...args),
    killAfterFailedPromotion: (...args) => real.killAfterFailedPromotion(...args),
  },
});
real = await import('./lib/shell-run-background/promote-job.mjs?real');

const { execShellCommand } = await import('./shell-command.mjs');
const { _resetNativeSpawnClientForTest, _setNativeSpawnBinaryForTest, shutdownNativeSpawnServer } = await import(
  './lib/native-spawn-client.mjs'
);

const binary = resolve(
  'native/mixdog-spawn/target/debug',
  process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn'
);
const skip = existsSync(binary) ? false : `native spawn test binary not found: ${binary}`;
if (!skip) _setNativeSpawnBinaryForTest(binary);
test.after(async () => {
  await shutdownNativeSpawnServer('test-finish').catch(() => {});
  _resetNativeSpawnClientForTest();
  cleanupTempDirs();
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

for (const event of ['close', 'exit']) {
  test(`a command that finishes during a failed promotion (${event} first) reports its completion`, {
    skip,
    timeout: 30_000,
  }, async () => {
    finishedAt = event;
    const repo = makeRepo();
    const result = await execShellCommand({
      shell: process.execPath,
      shellArg: '',
      directArgv: ['-e', 'setTimeout(() => console.log("finished-ok"), 600)'],
      command: 'finishes during promotion',
      cwd: repo,
      env: process.env,
      timeoutMs: 0,
      autoBackgroundMs: 200,
      backgroundOnTimeout: true,
      ownerSessionId: 'sess_promotion_race',
    });
    assert.equal(result.killed, false, result.killCause || result.stderr);
    assert.equal(result.backgrounded, false);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /finished-ok/);
    // A kill after the root's exit had no pre-kill snapshot: the workspace
    // stayed held as termination-unconfirmed for good.
    let free = false;
    for (let i = 0; i < 100 && !free; i += 1) {
      try {
        holdWorkspaceActivity([repo])();
        free = true;
      } catch {
        await delay(100);
      }
    }
    assert.ok(free, 'the finished command released its workspace');
  });
}
