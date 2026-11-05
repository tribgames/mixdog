// A background job whose command exited but left a child running (listed as
// "termination unconfirmed"): `/stop` counts and stops it like any background
// shell, and its record stops claiming an unconfirmed termination.
// Import before runtime modules: shell-job records are written under it.
import '../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after, mock } from 'node:test';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from '../lib/process-table-fixture.mjs';
import { waitUntil } from '../lib/wait-until-fixture.mjs';

const tasks = new Map();
const events = new EventEmitter();
function setTask(jobId, status) {
  const task = { ...tasks.get(jobId), status };
  tasks.set(jobId, task);
  events.emit(jobId, { ...task });
}
const noop = () => {};
mock.module('../lib/native-spawn-client.mjs', {
  namedExports: {
    getNativeTask: (jobId) => (tasks.has(jobId) ? { ...tasks.get(jobId) } : null),
    listNativeTasks: () => [...tasks.values()].map((task) => ({ ...task })),
    subscribeNativeTask: (jobId, listener) => {
      events.on(jobId, listener);
      return () => events.removeListener(jobId, listener);
    },
    cancelNativeTask: (jobId) => (tasks.has(jobId) ? { ...tasks.get(jobId) } : null),
    waitNativeTask: async (jobId) => (tasks.has(jobId) ? { ...tasks.get(jobId) } : null),
    releaseNativeTask: noop,
    promoteNativeTask: async ({ jobId, command, cwd, ownerSessionId }) => {
      tasks.set(jobId, { jobId, command, cwd, ownerSessionId, pid: Number(jobId.split('_').pop()), status: 'running' });
      return { ...tasks.get(jobId) };
    },
    setNativeTaskOutputPaths: noop,
    setNativeTaskStartedAt: noop,
    trackNativeForegroundTask: async () => null,
    cancelNativeTasks: () => ({ cancelled: 0, unconfirmed: [], confirmed: true }),
    tryNativeSpawn: () => null,
    ensureNativeSpawnServer: async () => null,
    warmNativeSpawnServer: async () => null,
    shutdownNativeSpawnServer: async () => {},
    setNativeSpawnRequestIdle: noop,
    nativeSpawnFileCaptureReady: () => false,
    nativeSpawnSupportsStdinPipe: () => false,
    _assertNativeSpawnCapabilitiesForTest: () => true,
    _resetNativeSpawnClientForTest: noop,
    _setNativeSpawnBinaryForTest: noop,
  },
});
const tree = scriptedChildTree();
mock.module('../../mcp/child-tree.mjs', { namedExports: tree.namedExports });

const { promoteWithRetry } = await import('../lib/shell-run-background/promote-job.mjs');
const { forceReleaseTerminationHold, noteShellOwnerSessionClosed, readShellJobRecord, shellOwnerEpoch, _shellJobRecordWritesSettledForTest } = await import(
  './lib/shell-job-records.mjs'
);

after(cleanupTempDirs);

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a command spawned before its owner closed keeps that incarnation through a later promotion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = 'sess_promote_epoch_owner';
  const pid = 7500;
  const jobId = `job_bg_${pid}`;
  const repo = makeRepo();
  tree.state.next = () => processTable([{ pid }, { pid: pid + 1, ppid: pid, token: 'worker' }]);
  // What the spawn recorded: the owner incarnation the command started in.
  const run = { child: { pid }, foregroundRecordId: jobId, foregroundRecordInput: { ownerEpoch: shellOwnerEpoch(owner) } };
  // The owner closes while the promotion has not happened yet.
  noteShellOwnerSessionClosed(owner);
  const { job } = await promoteWithRetry(
    { run, command: 'vite', cwd: repo, clientHostPid: process.pid, ownerSessionId: owner },
    { remainingBackgroundTimeoutMs: 0, stdoutPath: null, stderrPath: null }
  );
  assert.ok(job, 'promoted');
  await flush();
  await _shellJobRecordWritesSettledForTest(jobId);
  assert.equal((await readShellJobRecord(jobId)).ownerSessionClosed, true, 'the record belongs to the closed incarnation');

  // The command exits; its child keeps running, so the job is held.
  tree.state.next = () => processTable([{ pid: pid + 1, ppid: pid, token: 'worker' }]);
  setTask(jobId, 'completed');
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  const other = await forceReleaseTerminationHold(jobId, { callerSessionId: 'sess_viewer', callerCwd: repo });
  assert.equal(other.released, true, 'a session sharing the workspace releases the closed incarnation\'s hold');
});