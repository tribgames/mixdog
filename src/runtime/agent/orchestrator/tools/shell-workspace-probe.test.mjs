import './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.module('./lib/shell-descendants.mjs', {
  namedExports: {
    probeShellDescendants: async () => {
      throw new Error('process enumeration denied');
    },
    killShellDescendants: async () => assert.fail('An unknown tree must not be silently killed'),
    waitForShellDescendants: async () => assert.fail('No verified descendant handle exists'),
    createProcessTreeTracker: ({ pid }) => ({
      pid,
      exitAccepted: false,
      acceptExitObservation() {
        this.exitAccepted = true;
      },
    }),
    watchTermination: (options) => {
      watches.push(options);
      return () => {
        options.stopped = true;
      };
    },
    killAfterSnapshot: () => assert.fail('No kill was issued'),
    withinBound: (promise) => promise,
    PROCESS_TABLE_READ_BOUND_MS: 2_000,
  },
});
const watches = [];
const { createSettle } = await import('./lib/shell-run-settle.mjs');
const { forceReleaseTerminationHold } = await import('./builtin/lib/shell-job-records.mjs');

test('failed descendant observation reports failure and retains a releasable workspace admission', async () => {
  let released = 0;
  let result;
  const run = {
    child: { pid: process.pid, exitCode: 0, signalCode: null },
    rootExitAtMs: Date.now() - 2000,
    foregroundRecordId: 'job_unknown_children',
    workspaceAdmission: () => {
      released += 1;
    },
    stdoutDecoder: { end: () => '' },
    stderrDecoder: { end: () => '' },
    taskOutput: {
      spilled: false,
      getStdout: async () => '',
      getStderr: async () => '',
      closeFds() {},
      writeStdout() {},
      writeStderr() {},
    },
    resolveResult: (value) => {
      result = value;
    },
  };
  await createSettle(run, () => {})(0, null);
  assert.equal(released, 0);
  assert.equal(result.exitCode, 1);
  assert.match(result.failureReason, /could not be verified/);
  assert.equal(watches.length, 1, 'the held admission joins the termination watch');
  assert.equal(watches[0].tracker.exitAccepted, true, 'the root exited on its own');
  assert.deepEqual(await forceReleaseTerminationHold('job_unknown_children'), { released: true });
  assert.equal(released, 1);
  assert.equal(watches[0].stopped, true);
});
