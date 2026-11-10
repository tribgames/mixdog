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

const { promoteForegroundShellJob } = await import('./shell-jobs.mjs');
const { markShellJobTerminationUnconfirmed, readShellJobRecord, _shellJobRecordWritesSettledForTest } = await import(
  './lib/shell-job-records.mjs'
);
const { listStoppableShellJobs, stopBackgroundShellJobs } = await import('./task-tool.mjs');
const { completeBackgroundTask, registerBackgroundTask } = await import('../../../../shared/background-tasks.mjs');

after(cleanupTempDirs);

const OWNER = 'sess_stop_exited_root';
const ctx = { callerSessionId: OWNER, clientHostPid: process.pid };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('/stop lists and stops a job whose command exited, and its record then drops the unconfirmed claim', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pid = 7300;
  const jobId = `job_bg_${pid}`;
  tree.state.next = () => processTable([{ pid }, { pid: pid + 1, ppid: pid, token: 'worker' }]);
  await promoteForegroundShellJob({ command: 'ping -t localhost', cwd: makeRepo(), pid, jobId, ownerSessionId: OWNER });
  await flush();
  registerBackgroundTask({
    taskId: jobId,
    surface: 'shell',
    operation: 'shell',
    label: 'ping -t localhost',
    context: ctx,
  });
  // The command exits; its child keeps running and the job reads as held.
  tree.state.next = () => processTable([{ pid: pid + 1, ppid: pid, token: 'worker' }]);
  setTask(jobId, 'completed');
  completeBackgroundTask(jobId, { status: 'completed', result: {}, notify: false });
  await flush();
  await markShellJobTerminationUnconfirmed(jobId);
  assert.equal((await readShellJobRecord(jobId)).terminationUnconfirmed, true);

  assert.deepEqual(
    listStoppableShellJobs(ctx).map((job) => job.taskId),
    [jobId],
    'the survivor job counts as a background shell to stop'
  );

  const stopping = stopBackgroundShellJobs(ctx);
  await waitUntil(() => tree.state.kills.includes(pid + 1));
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  assert.deepEqual(await stopping, { stopped: 1, stopping: 0 });

  await _shellJobRecordWritesSettledForTest(jobId);
  const record = await readShellJobRecord(jobId);
  assert.equal(record.status, 'completed');
  assert.equal(record.terminationUnconfirmed, undefined, 'a confirmed stop is not reported as unconfirmed');
  assert.deepEqual(listStoppableShellJobs(ctx), []);
});
