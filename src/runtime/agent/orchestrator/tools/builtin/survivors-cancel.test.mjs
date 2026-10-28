// What a finished foreground command left running (the "survivors" task) is
// stopped by an agent close and by `task cancel`, which keeps terminating
// survivors that ignore the first kill.
// Import before runtime modules: shell-job records are written under it.
import '../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from '../lib/process-table-fixture.mjs';

const tasks = new Map();
const events = new EventEmitter();
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
    promoteNativeTask: async () => null,
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

const { renderCompletedResult } = await import('./bash-tool/completed-result.mjs');
const { adoptShellWorkspaceAdmission } = await import('./lib/shell-job-records.mjs');
const { executeTaskTool } = await import('./task-tool.mjs');
const { closeSession } = await import('../../session/manager/session-close.mjs');
const { getBackgroundTask } = await import('../../../../shared/background-tasks.mjs');

after(cleanupTempDirs);

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(read) {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (await read()) return;
    await flush();
  }
  assert.fail('the expected state never appeared');
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
const killsOf = (pid) => tree.state.kills.filter((killed) => killed === pid).length;

// The state a foreground command leaves when its root exited normally with a
// live descendant: folder admission adopted under the job id, survivors task
// registered.
function finishedCommandWithSurvivor({ jobId, owner, pid, reachable = true }) {
  const repo = makeRepo();
  adoptShellWorkspaceAdmission(jobId, tryAdmitWorkspaceActivity(owner, repo, { kind: 'command' }));
  tree.state.next = () => processTable([{ pid, ppid: 1, token: 'survivor' }]);
  renderCompletedResult({
    result: {
      exitCode: 0,
      stdout: '',
      stderr: '',
      descendants: {
        taskId: jobId,
        rootPid: pid - 1,
        groupPid: null,
        killPids: reachable ? [pid] : [],
        watchPids: [pid],
        watch: [{ pid, token: 'survivor', name: 'node.exe' }],
        reachable,
      },
    },
    command: 'npm run dev',
    analysisCommand: 'npm run dev',
    cwd: repo,
    options: { sessionId: owner, callerSessionId: owner },
    startedAtMs: Date.now(),
    stdout: '',
    stderr: '',
    timeout: 0,
  });
  return repo;
}

test('closing the owner session kills what its finished command left running and frees the folder', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = 'sess_close_survivor';
  const jobId = 'job_close_survivor';
  const repo = finishedCommandWithSurvivor({ jobId, owner, pid: 7301 });
  await flush();
  assert.equal(isHeld(repo), true);
  assert.equal(closeSession(owner, 'agent-close'), true);
  await until(() => killsOf(7301) > 0);
  assert.equal(getBackgroundTask(jobId).status, 'cancelled');
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => !isHeld(repo));
});

test('task cancel of survivors that ignore the kill is pending, and the watch keeps terminating them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = 'sess_cancel_survivor';
  const jobId = 'job_cancel_survivor';
  const ctx = { callerSessionId: owner, sessionId: owner, clientHostPid: process.pid };
  // The finished command's native entry is still cached.
  tasks.set(jobId, { jobId, status: 'completed', ownerSessionId: owner, exitCode: 0 });
  const repo = finishedCommandWithSurvivor({ jobId, owner, pid: 7401, reachable: false });
  await flush();
  const text = String(await executeTaskTool({ action: 'cancel', task_id: jobId }, ctx));
  assert.match(text, /cancel-pending/);
  assert.equal(isHeld(repo), true, 'the survivor still runs and holds the folder');
  const sent = killsOf(7401);
  assert.ok(sent > 0, 'the cancel sent a kill');
  t.mock.timers.tick(5_000);
  await until(() => killsOf(7401) > sent);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => !isHeld(repo));
});
