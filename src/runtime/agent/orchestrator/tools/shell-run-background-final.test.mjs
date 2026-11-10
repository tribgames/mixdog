// Import before runtime modules: several paths are captured at module load.
import './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// The child exits while promotion is committing.
mock.module('./lib/shell-run-background/promote-job.mjs', {
  namedExports: {
    promoteWithRetry: async ({ run }) => {
      run.child.exitCode = 0;
      return { job: { jobId: 'job-1' } };
    },
    handOverLease: async () => {},
    killAfterFailedPromotion: () => {},
  },
});

const { createAutoBackground } = await import('./lib/shell-run-background.mjs');

test('completed-during-promotion resolves with the final read, not the mid-run snapshot', async () => {
  const reads = [];
  const taskOutput = {
    spilled: true,
    stdoutPath: 'out.log',
    stderrPath: 'err.log',
    stdoutFileSize: 5,
    stderrFileSize: 0,
    writeError: null,
    forceSpill() {},
    async getStdout(final = false) {
      reads.push(final);
      return final ? 'ok \uFFFD' : 'ok ';
    },
    async getStderr() {
      return '';
    },
  };
  let result;
  const run = {
    taskOutput,
    abortSignal: null,
    child: { exitCode: null, signalCode: null },
    taskId: 'task-1',
    startMs: Date.now(),
    settled: false,
    autoBackgrounded: false,
    killed: false,
    timedOut: false,
    resolveResult: (value) => {
      result = value;
    },
    isResolved: () => result !== undefined,
  };
  const autoBackground = createAutoBackground({
    run,
    command: 'x',
    cwd: '.',
    promotedTimeoutMs: 0,
    backgroundDeadlineMs: 0,
  });
  autoBackground({ reason: 'threshold' });
  for (let i = 0; i < 50 && !result; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(result, 'resolved');
  assert.equal(result.backgrounded, false);
  assert.equal(result.stdout, 'ok \uFFFD');
  assert.deepEqual(reads, [false, true]);
});
