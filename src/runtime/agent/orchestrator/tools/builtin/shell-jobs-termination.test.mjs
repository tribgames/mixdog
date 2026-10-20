// Import before runtime modules: shell-job records are written under it.
import '../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from '../lib/process-table-fixture.mjs';

// In-memory native runner and a scripted process table.
const tasks = new Map();
const events = new EventEmitter();
const onCancel = new Map();
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
    cancelNativeTask: (jobId) => {
      if (!tasks.has(jobId)) return null;
      onCancel.get(jobId)?.();
      setTask(jobId, 'cancelled');
      return { ...tasks.get(jobId) };
    },
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

const { killShellJob, promoteForegroundShellJob } = await import('./shell-jobs.mjs');
const {
  _shellJobRecordWritesSettledForTest,
  forceReleaseTerminationHold,
  noteShellOwnerSessionClosed,
  readShellJobRecord,
} = await import('./lib/shell-job-records.mjs');
const { cancelOwnedShellTrees } = await import('../lib/owned-shell-trees.mjs');
const { shellJobsStatusFresh } = await import('../../../../shared/statusline/statusline-segments.mjs');

after(cleanupTempDirs);

const flush = () => new Promise((resolve) => setImmediate(resolve));
// The record files are written through the job's async queue; wait on the
// observable state itself, a bounded number of event-loop turns.
async function until(read) {
  for (let turn = 0; turn < 1_000; turn += 1) {
    const value = await read();
    if (value) return value;
    await flush();
  }
  assert.fail('the expected record state never appeared');
}
const isHeld = (repo) => {
  try {
    holdWorkspaceActivity([repo])();
    return false;
  } catch (error) {
    assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
    return true;
  }
};
// The root pids are not live processes: the record's own reader (filed under
// the root pid) is dropped by the gate, exactly as after a real root exit.
const promote = (repo, pid) =>
  promoteForegroundShellJob({
    command: 'npm run dev',
    cwd: repo,
    pid,
    jobId: `job_bg_${pid}`,
    ownerSessionId: 'sess_bg',
  });

test('a background job that exits on its own keeps the folder until its survivors are gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  tree.state.next = () => processTable([{ pid: 6100 }, { pid: 6101, ppid: 6100 }]);
  await promote(repo, 6100);
  await flush();
  tree.state.next = () => processTable([{ pid: 6101, ppid: 6100 }]);
  setTask('job_bg_6100', 'completed');
  await flush();
  assert.equal(isHeld(repo), true, 'the native terminal status is not termination');
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(isHeld(repo), true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => !isHeld(repo));
});

test('a killed background job tracks a grandchild the kill orphaned', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  tree.state.next = () =>
    processTable([{ pid: 6200 }, { pid: 6201, ppid: 6200 }, { pid: 6202, ppid: 6201, token: 'worker' }]);
  await promote(repo, 6200);
  await flush();
  onCancel.set('job_bg_6200', () => {
    tree.state.next = () => processTable([{ pid: 6202, ppid: 6201, token: 'worker' }]);
  });
  assert.ok(killShellJob('job_bg_6200'));
  await flush();
  assert.equal(tasks.get('job_bg_6200').status, 'cancelled');
  assert.equal(isHeld(repo), true, 'the orphaned worker still runs');
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(isHeld(repo), true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => !isHeld(repo));
});

test('a background job left unconfirmed is flagged on its record and can be force-released', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  tree.state.next = () => {
    throw new Error('process enumeration denied');
  };
  await promote(repo, 6300);
  await flush();
  setTask('job_bg_6300', 'completed');
  const record = await until(async () => {
    // Under load the record's file writes outlast any fixed number of
    // event-loop turns: read only once the writes queued so far have landed.
    await _shellJobRecordWritesSettledForTest('job_bg_6300');
    const current = await readShellJobRecord('job_bg_6300');
    return current?.terminationUnconfirmed ? current : null;
  });
  assert.equal(record.status, 'running', 'the record completes only with the lifecycle');
  assert.equal(record.terminationUnconfirmed, true);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(isHeld(repo), true, 'no timer releases it');
  assert.equal((await forceReleaseTerminationHold('job_bg_6300', { callerSessionId: 'someone-else' })).released, false);
  assert.deepEqual(await forceReleaseTerminationHold('job_bg_6300', { callerSessionId: 'sess_bg' }), {
    released: true,
  });
  assert.equal(isHeld(repo), false);
  const done = await readShellJobRecord('job_bg_6300');
  assert.equal(done.terminal, true);
  assert.equal(done.status, 'completed');
});

test('closing a job owner without a snapshot keeps its hold visible until explicit release', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  // No identity snapshot ever lands: neither the promotion baseline nor the
  // pre-kill read.
  tree.state.next = () => {
    throw new Error('process enumeration denied');
  };
  await promoteForegroundShellJob({
    command: 'npm run dev',
    cwd: repo,
    pid: 6400,
    jobId: 'job_bg_6400',
    ownerSessionId: 'sess_closing',
  });
  await flush();
  // The session close: owner cancel, then the owner is noted closed.
  await cancelOwnedShellTrees('sess_closing');
  noteShellOwnerSessionClosed('sess_closing');
  tree.state.next = () => processTable([{ pid: 6402, ppid: 1, token: 'detached-worker', pgid: 6402 }]);
  setTask('job_bg_6400', 'cancelled');
  const record = await until(async () => {
    await _shellJobRecordWritesSettledForTest('job_bg_6400');
    const current = await readShellJobRecord('job_bg_6400');
    return current?.terminationUnconfirmed || current?.terminal ? current : null;
  });
  assert.equal(record.status, 'running', 'the native root exit cannot confirm an incomplete tree');
  assert.equal(record.terminationUnconfirmed, true);
  assert.equal(isHeld(repo), true);
  const status = await shellJobsStatusFresh({ clientHostPid: process.pid });
  assert.equal(status.orphaned.find((job) => job.taskId === 'job_bg_6400')?.terminationUnconfirmed, true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(isHeld(repo), true, 'an empty later table cannot reconstruct the missing snapshot');
  assert.deepEqual(
    await forceReleaseTerminationHold('job_bg_6400', { callerSessionId: 'viewer', callerCwd: repo }),
    { released: true }
  );
  assert.equal(isHeld(repo), false);
  const done = await readShellJobRecord('job_bg_6400');
  assert.equal(done.terminal, true);
  assert.equal(done.status, 'cancelled');
  const released = await shellJobsStatusFresh({ clientHostPid: process.pid });
  assert.equal((released.orphaned || []).some((job) => job.taskId === 'job_bg_6400'), false);
});
