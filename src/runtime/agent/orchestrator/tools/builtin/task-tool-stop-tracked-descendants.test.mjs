// Import before runtime modules: shell-job records are written under it.
import '../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after, mock } from 'node:test';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from '../lib/process-table-fixture.mjs';

// In-memory native runner and a scripted process table.
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
const { stopBackgroundShellJob } = await import('./task-tool.mjs');
const { completeBackgroundTask, registerBackgroundTask } = await import('../../../../shared/background-tasks.mjs');

after(cleanupTempDirs);

const OWNER = 'sess_stop_tracked';
const ctx = { callerSessionId: OWNER, clientHostPid: process.pid };
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(read) {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (await read()) return;
    await flush();
  }
  assert.fail('the expected state never appeared');
}

// A promoted job whose root completed while `worker` keeps running.
async function completedRootWithWorker(pid, { expireNative = false } = {}) {
  const jobId = `job_bg_${pid}`;
  tree.state.next = () => processTable([{ pid }, { pid: pid + 1, ppid: pid, token: 'worker' }]);
  await promoteForegroundShellJob({
    command: 'npm run dev',
    cwd: makeRepo(),
    pid,
    jobId,
    ownerSessionId: OWNER,
  });
  await flush();
  registerBackgroundTask({ taskId: jobId, surface: 'shell', operation: 'shell', label: 'npm run dev', context: ctx });
  tree.state.next = () => processTable([{ pid: pid + 1, ppid: pid, token: 'worker' }]);
  setTask(jobId, 'completed');
  completeBackgroundTask(jobId, { status: 'completed', result: {}, notify: false });
  if (expireNative) tasks.delete(jobId);
  await flush();
  return jobId;
}

for (const expireNative of [false, true]) {
  test(`Stop of a completed root kills its live descendants, then reports it finished (native entry ${
    expireNative ? 'expired' : 'cached'
  })`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pid = expireNative ? 7110 : 7100;
    const jobId = await completedRootWithWorker(pid, { expireNative });
    const stop = stopBackgroundShellJob(jobId, ctx);
    await until(() => tree.state.kills.includes(pid + 1));
    tree.state.next = () => processTable([]);
    t.mock.timers.tick(5_000);
    assert.deepEqual(await stop, { stopped: true });
    assert.match((await stopBackgroundShellJob(jobId, ctx)).error, /already completed/);
  });
}
