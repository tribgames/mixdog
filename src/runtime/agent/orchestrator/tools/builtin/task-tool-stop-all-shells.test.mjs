// `/stop`: every background shell of ONE session (promoted jobs and the
// survivors a finished command left) through the confirmed per-task cancel.
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
const nativeCancels = [];
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
      nativeCancels.push(jobId);
      return tasks.has(jobId) ? { ...tasks.get(jobId) } : null;
    },
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
const { listStoppableShellJobs, stopBackgroundShellJobs } = await import('./task-tool.mjs');
const { createAgentOps } = await import('../../../../../session-runtime/turn/agent-ops.mjs');
const { cancelBackgroundTasks, getBackgroundTask, registerBackgroundTask } = await import(
  '../../../../shared/background-tasks.mjs'
);

after(cleanupTempDirs);

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(read, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!read()) {
    assert.ok(Date.now() < deadline, 'condition not reached');
    await flush();
  }
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
const ctx = (sessionId) => ({ callerSessionId: sessionId, clientHostPid: process.pid });

function registerJob(taskId, sessionId, command) {
  return registerBackgroundTask({
    taskId,
    surface: 'shell',
    operation: 'shell',
    label: command,
    input: { command },
    context: ctx(sessionId),
    cancel: noop,
  });
}

// The state a foreground command leaves when its root exited with a live
// descendant: folder admission adopted under the job id, survivors task registered.
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

test('with nothing running there is nothing to stop', async () => {
  const owner = 'sess_stopall_empty';
  assert.deepEqual(listStoppableShellJobs(ctx(owner)), []);
  assert.deepEqual(await stopBackgroundShellJobs(ctx(owner)), { stopped: 0, stopping: 0 });
});

test('two background jobs and a survivors task are listed, then all stopped; other sessions and the foreground command are untouched', async () => {
  const owner = 'sess_stopall_owner';
  const other = 'sess_stopall_other';
  const a = registerJob('job_stopall_a', owner, 'npm run dev');
  const b = registerJob('job_stopall_b', owner, 'tail -f log');
  const foreign = registerJob('job_stopall_foreign', other, 'sleep 999');
  // The running foreground command of the current turn: a native task with no
  // background task behind it.
  tasks.set('job_stopall_foreground', { jobId: 'job_stopall_foreground', status: 'running', ownerSessionId: owner });
  const repo = finishedCommandWithSurvivor({ jobId: 'job_stopall_survivors', owner, pid: 7501 });
  await flush();

  const listed = listStoppableShellJobs(ctx(owner));
  assert.deepEqual(listed.map((job) => job.taskId).sort(), ['job_stopall_a', 'job_stopall_b', 'job_stopall_survivors']);
  assert.deepEqual(
    listed.find((job) => job.taskId === 'job_stopall_a'),
    { taskId: 'job_stopall_a', command: 'npm run dev' }
  );
  assert.deepEqual(
    listStoppableShellJobs(ctx(other)).map((job) => job.taskId),
    ['job_stopall_foreign']
  );
  assert.equal(isHeld(repo), true);

  // The survivor exits once killed.
  tree.state.next = () => processTable([]);
  const ops = createAgentOps({
    getSession: () => ({ id: owner }),
    getCurrentCwd: () => process.cwd(),
    getMode: () => 'default',
    notifyFnForSession: () => null,
    activeToolSurface: () => null,
    notificationListeners: new Set(),
  });
  assert.equal((await ops.listStoppableShellJobs()).jobs.length, 3);
  assert.deepEqual(await ops.stopShellJobs(), { stopped: 3, stopping: 0 });

  assert.equal(a.status, 'cancelled');
  assert.equal(b.status, 'cancelled');
  assert.equal(getBackgroundTask('job_stopall_survivors').status, 'cancelled');
  assert.equal(foreign.status, 'running', 'another session keeps its job');
  assert.equal(tasks.get('job_stopall_foreground').status, 'running');
  assert.ok(!nativeCancels.includes('job_stopall_foreground'), 'the foreground command is never cancelled');
  assert.deepEqual(listStoppableShellJobs(ctx(owner)), []);
  await until(() => !isHeld(repo));
});

test('a survivor that ignores the kill ends as still stopping and keeps being swept', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = 'sess_stopall_stubborn';
  const jobId = 'job_stopall_stubborn';
  tasks.set(jobId, { jobId, status: 'completed', ownerSessionId: owner, exitCode: 0 });
  const repo = finishedCommandWithSurvivor({ jobId, owner, pid: 7601, reachable: false });
  await flush();

  assert.deepEqual(await stopBackgroundShellJobs(ctx(owner)), { stopped: 0, stopping: 1 });
  assert.equal(isHeld(repo), true, 'the survivor still runs and holds the folder');
  const sent = killsOf(7601);
  assert.ok(sent > 0, 'the stop sent a kill');
  t.mock.timers.tick(5_000);
  await until(() => killsOf(7601) > sent);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => !isHeld(repo));
});

test('/stop and the close/reap sweep select the same jobs, for a lead and for an agent sub-session', () => {
  // A tool call's context names the executing session as caller and routing
  // session, whether that is the lead or an agent sub-session.
  const sessions = ['lead_scope_a', 'agent_scope_b'];
  for (const sessionId of sessions) {
    for (const n of [1, 2]) {
      registerBackgroundTask({
        taskId: `${sessionId}_job_${n}`,
        surface: 'shell',
        operation: 'shell',
        label: 'sleep',
        input: { command: 'sleep' },
        context: { callerSessionId: sessionId, routingSessionId: sessionId, clientHostPid: process.pid },
        cancel: noop,
      });
    }
  }
  for (const sessionId of sessions) {
    const listed = listStoppableShellJobs(ctx(sessionId))
      .map((job) => job.taskId)
      .sort();
    assert.deepEqual(listed, [`${sessionId}_job_1`, `${sessionId}_job_2`]);
    const swept = cancelBackgroundTasks({ surface: 'shell', executionSessionId: sessionId, notify: false });
    assert.deepEqual(swept.taskIds.sort(), listed);
  }
});
