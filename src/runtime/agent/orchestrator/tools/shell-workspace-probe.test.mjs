import './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// The real helpers the mocked watch is built from: loaded before the mock so
// shell-jobs.mjs (imported by the settle) finds every export it names.
const { createContainedTreeTracker, endWatchWhenUnconfirmable, sweepLiveIdentities } = await import(
  './lib/shell-descendants.mjs'
);
mock.module('./lib/shell-descendants.mjs', {
  namedExports: {
    createContainedTreeTracker,
    endWatchWhenUnconfirmable,
    sweepLiveIdentities,
    probeShellDescendants: async () => {
      throw new Error('process enumeration denied');
    },
    killShellDescendants: async () => assert.fail('An unknown tree must not be silently killed'),
    waitForShellDescendants: async () => assert.fail('No verified descendant handle exists'),
    createProcessTreeTracker: ({ pid }) => ({
      pid,
      exitAccepted: false,
      // As the real tracker: complete only once the root's exit was observed
      // (acceptExitObservation) or its tree was captured before a kill.
      complete: false,
      // The descendant table cannot be read: every observation is unknown.
      observe: async () => 'unknown',
      acceptExitObservation() {
        this.exitAccepted = true;
        this.complete = true;
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

// A settled run whose descendant table cannot be read. `extra` sets how it
// ended (a root that exited on its own, or a killed one).
function unverifiedRun(foregroundRecordId, extra = {}) {
  const state = { released: 0, result: null };
  const run = {
    child: { pid: process.pid, exitCode: 0, signalCode: null },
    rootExitAtMs: Date.now() - 2000,
    foregroundRecordId,
    workspaceAdmission: () => {
      state.released += 1;
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
      state.result = value;
    },
    ...extra,
  };
  return { run, state };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('failed descendant observation reports failure and retains a releasable workspace admission', async () => {
  const { run, state } = unverifiedRun('job_unknown_children');
  const before = watches.length;
  await createSettle(run, () => {})(0, null);
  const { result } = state;
  assert.equal(state.released, 0);
  assert.equal(result.exitCode, 1);
  assert.match(result.failureReason, /could not be verified/);
  assert.equal(watches.length, before + 1, 'the held admission joins the termination watch');
  const watch = watches.at(-1);
  assert.equal(watch.tracker.exitAccepted, true, 'the root exited on its own');
  assert.equal(watch.tracker.complete, true, 'its exit was observed');
  let settled = 0;
  void result.settled.then(() => {
    settled += 1;
  });
  assert.deepEqual(await forceReleaseTerminationHold('job_unknown_children'), { released: true });
  assert.equal(state.released, 1);
  // A force-release drops only the workspace hold: the watch stays owned and
  // the tree is not reported settled.
  assert.notEqual(watch.stopped, true, 'the released tree stays under observation');
  assert.equal(settled, 0, 'a release is not proof of termination');
  // A transient unknown on a tree whose exit was observed keeps the watch.
  assert.equal(await watch.tracker.observe({ rootExited: true }), 'unknown');
  await nextTurn();
  assert.notEqual(watch.stopped, true, 'a transient unknown does not end the watch');
  assert.equal(settled, 0);
  // The confirmed exit settles it once, without releasing the admission again.
  await watch.onTerminated();
  await nextTurn();
  assert.equal(watch.stopped, true);
  assert.equal(settled, 1, 'the confirmed exit settles the tree');
  await watch.onTerminated();
  await nextTurn();
  assert.equal(settled, 1, 'settled exactly once');
  assert.equal(state.released, 1, 'the admission is released exactly once');
});

test('after a release an unknown observation ends the watch of a capture that can never complete', async () => {
  // A killed run: its exit was never accepted, so the tracker stays incomplete.
  const { run, state } = unverifiedRun('job_incomplete_capture', { killed: true });
  const before = watches.length;
  await createSettle(run, () => {})(null, 'SIGKILL');
  const { result } = state;
  assert.equal(watches.length, before + 1, 'the killed tree joins the termination watch');
  const watch = watches.at(-1);
  assert.equal(watch.tracker.exitAccepted, false, 'no exit observation was accepted');
  assert.equal(watch.tracker.complete, false);
  let settled = 0;
  void result.settled.then(() => {
    settled += 1;
  });
  assert.deepEqual(await forceReleaseTerminationHold('job_incomplete_capture'), { released: true });
  assert.equal(state.released, 1);
  assert.notEqual(watch.stopped, true, 'the release alone does not end the watch');
  assert.equal(await watch.tracker.observe({ rootExited: true }), 'unknown');
  assert.equal(watch.stopped, true, 'the unconfirmable watch ends');
  await nextTurn();
  assert.equal(settled, 0, 'an unconfirmed tree is never reported settled');
  assert.equal(state.released, 1, 'the admission is released exactly once');
});
