import './isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from './process-table-fixture.mjs';

let child = Object.assign(new EventEmitter(), { pid: 4243, exitCode: null, signalCode: null });
let startup = new AbortController();
const published = [];
// The native side of the startup kill: by default it never reports a
// terminal status.
let nativeKill = () => {};
let nativeDetail = { nativeStatus: 'running' };

// Everything below the spawn call is scripted: the child is created, the
// startup then fails, and the native task reports `nativeDetail`.
mock.module('../builtin/shell-jobs.mjs', {
  namedExports: {
    killShellJob: () => nativeKill(),
    waitForShellJob: async () => nativeDetail,
    publishForegroundShellRecord: (input) => published.push(input),
    trackForegroundShellJob: async () => null,
    retireForegroundShellRecord() {},
  },
});
mock.module('./native-spawn-client.mjs', {
  namedExports: {
    nativeSpawnFileCaptureReady: () => false,
    nativeSpawnSupportsStdinPipe: () => false,
    setNativeTaskStartedAt() {},
    warmNativeSpawnServer: async () => false,
    setNativeSpawnRequestIdle() {},
    tryNativeSpawn: async () => null,
    // Owner-wide cancel (session close); never sent in these tests.
    cancelNativeTasks: () => ({ cancelled: 0, unconfirmed: [], confirmed: true }),
  },
});
mock.module('./shell-spawn-retry.mjs', {
  namedExports: {
    spawnShellWithRetry: async () => {
      startup.abort(); // fails the startup right after the child exists
      return { child, attachErrorHandler() {} };
    },
  },
});
// The process table: the child (and so its tree) is alive until it exits.
const tree = scriptedChildTree();
const childOnly = () => processTable(child.exitCode == null ? [{ pid: child.pid }] : []);
tree.state.next = childOnly;
mock.module('../../mcp/child-tree.mjs', { namedExports: tree.namedExports });
const { spawnShellChild } = await import('./shell-run-spawn.mjs');
const { forceReleaseTerminationHold } = await import('../builtin/lib/shell-job-records.mjs');

after(cleanupTempDirs);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const isHeld = (repo) => {
  try {
    holdWorkspaceActivity([repo])();
    return false;
  } catch (error) {
    assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
    return true;
  }
};

test('a startup whose child termination is unconfirmed keeps the reservation until the child is gone', async () => {
  const repo = makeRepo();
  const run = { foregroundRecordId: 'job_unconfirmed_startup' };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assert.rejects(
      spawnShellChild({
        run,
        cwd: repo,
        shell: process.execPath,
        directArgv: ['-e', ''],
        command: 'node',
        abortSignal: startup.signal,
        ownerSessionId: 'startup-failure',
      }),
      (error) => error instanceof AggregateError
    );
    assert.equal(run.killUnconfirmed, true);
    assert.equal(run.terminationTracker.complete, true, 'identities were captured before the kill');
    await flush();
    assert.equal(isHeld(repo), true);
    const record = published.at(-1);
    assert.equal(record?.terminationUnconfirmed, true, 'the held command stays visible');
    assert.equal(record.jobId, 'job_unconfirmed_startup');
    assert.equal(record.command, 'node');
    assert.equal(record.cwd, repo);
    assert.equal(record.ownerSessionId, 'startup-failure');
    assert.equal(
      (await forceReleaseTerminationHold('job_unconfirmed_startup', { callerSessionId: 'other' })).released,
      false,
      'the hold is owned: another session cannot release it'
    );
    assert.equal(isHeld(repo), true);
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await flush();
    assert.equal(isHeld(repo), true, 'the exit is confirmed by the next observation, not the event');
    mock.timers.tick(5_000);
    await flush();
  } finally {
    mock.timers.reset();
  }
  assert.equal(run.workspaceAdmission, null);
  assert.equal(isHeld(repo), false);
});

test('a failed startup whose killed root leaves a descendant keeps the reservation until it is gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  child = Object.assign(new EventEmitter(), { pid: 4250, exitCode: null, signalCode: null });
  startup = new AbortController();
  const worker = { pid: 4251, ppid: 4250, token: 'worker' };
  tree.state.next = () => processTable([{ pid: 4250 }, worker]);
  // The native kill ends the root; the worker it started survives.
  nativeKill = () => {
    child.exitCode = 1;
    tree.state.next = () => processTable([{ ...worker, ppid: 1 }]);
    nativeDetail = { nativeStatus: 'cancelled' };
  };
  const run = { foregroundRecordId: 'job_startup_survivor' };
  t.after(() => {
    nativeKill = () => {};
    nativeDetail = { nativeStatus: 'running' };
    tree.state.next = childOnly;
  });
  await assert.rejects(
    spawnShellChild({
      run,
      cwd: repo,
      shell: process.execPath,
      directArgv: ['-e', ''],
      command: 'node',
      abortSignal: startup.signal,
      ownerSessionId: 'startup-failure',
    })
  );
  await flush();
  assert.equal(isHeld(repo), true, 'the root exit is not the end of its tree');
  assert.ok(tree.state.kills.includes(worker.pid), 'the surviving worker is swept like any killed tree');
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(isHeld(repo), true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(isHeld(repo), false);
  assert.equal(run.workspaceAdmission, null);
});
