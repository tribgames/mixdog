// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from '../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { getBackgroundTask, registerBackgroundTask } from '../../../../shared/background-tasks.mjs';
import { shellJobsStatus } from '../../../../shared/statusline/statusline-segments.mjs';
import { createAgentOps } from '../../../../../session-runtime/turn/agent-ops.mjs';
import { execShellCommand } from '../shell-command.mjs';
import { killShellJob, shutdownShellJobs, waitShellJobTerminated, watchBackgroundShellJob } from './shell-jobs.mjs';
import { stopBackgroundShellJob } from './task-tool.mjs';
import { PROCESS_TABLE_READ_BOUND_MS, TERMINATION_RECHECK_MS } from '../lib/shell-descendants.mjs';
import {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  getNativeTask,
  shutdownNativeSpawnServer,
} from '../lib/native-spawn-client.mjs';

const OWNER = 'sess_stop_owner';
const OTHER = 'sess_stop_other';
const ctx = (sessionId) => ({ callerSessionId: sessionId, clientHostPid: process.pid });

const binary = resolve(
  'native/mixdog-spawn/target/debug',
  process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn'
);
const hasBinary = existsSync(binary);
const skipNative = hasBinary ? false : `native spawn test binary not found: ${binary}`;
if (hasBinary) _setNativeSpawnBinaryForTest(binary);
const keepAlive = setInterval(() => {}, 1_000);
test.after(async () => {
  clearInterval(keepAlive);
  if (!hasBinary) return;
  await shutdownShellJobs('test-cleanup');
  await shutdownNativeSpawnServer('test-finish').catch(() => {});
  _resetNativeSpawnClientForTest();
});

function registerShellTask(taskId, sessionId, extra = {}) {
  return registerBackgroundTask({
    taskId,
    surface: 'shell',
    operation: 'shell',
    label: 'sleep',
    context: ctx(sessionId),
    ...extra,
  });
}

test('stopBackgroundShellJob rejects blank, unknown, other-session and non-shell tasks', async () => {
  assert.deepEqual(await stopBackgroundShellJob('  ', ctx(OWNER)), { stopped: false, error: 'task_id is required' });
  assert.deepEqual(await stopBackgroundShellJob('job_stop_missing', ctx(OWNER)), {
    stopped: false,
    error: 'task not found: job_stop_missing',
  });

  const task = registerShellTask('job_stop_scoped', OWNER);
  assert.equal((await stopBackgroundShellJob('job_stop_scoped', ctx(OTHER))).stopped, false);
  assert.equal(task.status, 'running', 'another session cannot stop the job');

  registerBackgroundTask({ taskId: 'job_stop_agent', surface: 'agent', context: ctx(OWNER) });
  assert.equal((await stopBackgroundShellJob('job_stop_agent', ctx(OWNER))).stopped, false);

  assert.deepEqual(await stopBackgroundShellJob('job_stop_scoped', ctx(OWNER)), { stopped: true });
  assert.equal(getBackgroundTask('job_stop_scoped').status, 'cancelled');
});

test('stopBackgroundShellJob reports an already finished task instead of stopping it', async () => {
  let cancels = 0;
  registerShellTask('job_stop_twice', OWNER, { cancel: () => (cancels += 1) });
  assert.deepEqual(await stopBackgroundShellJob('job_stop_twice', ctx(OWNER)), { stopped: true });
  assert.equal(cancels, 1);
  const again = await stopBackgroundShellJob('job_stop_twice', ctx(OWNER));
  assert.equal(again.stopped, false);
  assert.match(again.error, /already cancelled/);
  assert.equal(cancels, 1);
});

test('the runtime stopShellJob scopes the stop to its own session', async () => {
  const ops = (sessionId) =>
    createAgentOps({
      getSession: () => ({ id: sessionId }),
      getCurrentCwd: () => process.cwd(),
      getMode: () => 'default',
      notifyFnForSession: () => null,
      activeToolSurface: () => null,
      notificationListeners: new Set(),
    });
  registerShellTask('job_stop_runtime', OWNER);
  const miss = await ops(OTHER).stopShellJob('job_stop_runtime');
  assert.equal(miss.stopped, false);
  assert.equal(getBackgroundTask('job_stop_runtime').status, 'running');
  assert.deepEqual(await ops(OWNER).stopShellJob('job_stop_runtime'), { stopped: true });
  assert.equal(getBackgroundTask('job_stop_runtime').status, 'cancelled');
});

test('stopping a real background job settles it as cancelled in the shell-jobs status', {
  skip: skipNative,
  timeout: 60_000,
}, async () => {
  const result = await execShellCommand({
    shell: process.execPath,
    shellArg: '',
    env: process.env,
    cwd: fixtureRoot,
    command: 'long stop-me',
    directArgv: ['-e', 'setTimeout(() => {}, 60000)'],
    timeoutMs: 0,
    autoBackgroundMs: 200,
    backgroundOnTimeout: true,
    ownerSessionId: OWNER,
    callerSessionId: OWNER,
  });
  assert.equal(result.backgrounded, true, result.stderr);
  const jobId = result.jobId;
  assert.equal(getNativeTask(jobId)?.status, 'running');
  // What the bash tool does with a promoted job (backgrounded-result.mjs).
  registerShellTask(jobId, OWNER, { cancel: () => killShellJob(jobId) });
  watchBackgroundShellJob(jobId, { callerSessionId: OWNER, routingSessionId: OWNER, clientHostPid: process.pid });

  assert.equal((await stopBackgroundShellJob(jobId, ctx(OTHER))).stopped, false);
  assert.equal(getNativeTask(jobId)?.status, 'running');

  const stop = await stopBackgroundShellJob(jobId, ctx(OWNER));
  assert.notEqual(getNativeTask(jobId)?.status, 'running');
  if (!stop.stopped) {
    // On a heavily loaded machine the process-table reads that confirm the
    // whole tree is gone can outlast the 15 s confirmation ceiling; the stop
    // then says so (and the job stays tracked) instead of claiming a cancel.
    assert.match(stop.error, /cancellation not confirmed/);
    assert.equal(await waitShellJobTerminated(jobId, 60_000), true, 'the tree is eventually confirmed gone');
    return;
  }
  assert.deepEqual(stop, { stopped: true });
  assert.equal(getBackgroundTask(jobId).status, 'cancelled');
  assert.match((await stopBackgroundShellJob(jobId, ctx(OWNER))).error, /already/);

  // The record completes with the job's lifecycle: once its processes are
  // confirmed gone — the kill's snapshot bound plus up to two observation
  // passes (one may be unanswered under load).
  let bucket;
  const deadline = Date.now() + PROCESS_TABLE_READ_BOUND_MS + 2 * TERMINATION_RECHECK_MS;
  while (Date.now() < deadline) {
    bucket = shellJobsStatus({ clientHostPid: process.pid }).sessions?.[OWNER];
    if (bucket?.finished?.some((row) => row.taskId === jobId)) break;
    await delay(100);
  }
  assert.equal(bucket.count, 0);
  const row = bucket.finished.find((entry) => entry.taskId === jobId);
  assert.equal(row.status, 'cancelled');
});
