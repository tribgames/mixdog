// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';
import { processTable, scriptedChildTree } from './lib/process-table-fixture.mjs';

// The root exits while its promotion is pending, and a grandchild that
// inherited stdout keeps 'close' from ever arriving: the 3 s drain grace is
// the only terminal event left, and it fires before the promotion fails.
let child = null;
mock.module('./lib/shell-run-spawn.mjs', {
  namedExports: {
    spawnShellChild: async ({ run }) => {
      child = Object.assign(new EventEmitter(), {
        pid: 4801,
        exitCode: null,
        signalCode: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      run.child = child;
    },
  },
});
const tree = scriptedChildTree();
tree.state.next = () => processTable([]);
mock.module('../mcp/child-tree.mjs', { namedExports: tree.namedExports });
let real = null;
let advanceTimers = null;
mock.module('./lib/shell-run-background/promote-job.mjs', {
  namedExports: {
    promoteWithRetry: async ({ run }) => {
      child.stdout.emit('data', Buffer.from('finished-ok\n'));
      child.exitCode = 0;
      child.emit('exit', 0, null);
      advanceTimers(3_000);
      return { job: null, promotionFailure: `no native task record for jobId ${run.foregroundRecordId}` };
    },
    handOverLease: (...args) => real.handOverLease(...args),
    killAfterFailedPromotion: (...args) => real.killAfterFailedPromotion(...args),
  },
});
real = await import('./lib/shell-run-background/promote-job.mjs?real');

const { execShellCommand } = await import('./shell-command.mjs');

test('a failed promotion settles with the exit its drain grace already consumed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  advanceTimers = (ms) => t.mock.timers.tick(ms);
  const wake = new AbortController();
  wake.abort('input');
  let result;
  void execShellCommand({
    shell: process.execPath,
    shellArg: '',
    command: 'node server-launcher.js',
    env: process.env,
    cwd: fixtureRoot,
    timeoutMs: 0,
    backgroundOnTimeout: true,
    wakeSignal: wake.signal,
    admission: { acquire: async () => ({ release: async () => {} }) },
  }).then((value) => {
    result = value;
  });
  for (let turn = 0; turn < 100 && !result; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(result, 'the call resolves without waiting for a stdio close that never comes');
  assert.equal(result.backgrounded, false);
  assert.equal(result.killed, false, result.killCause || result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.partialOutput, true);
  assert.match(result.stdout, /finished-ok/);
});
