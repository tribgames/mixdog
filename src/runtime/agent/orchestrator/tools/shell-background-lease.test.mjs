// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ResourceAdmissionController, resourceAdmission } from '../../../shared/resource-admission.mjs';
import { cancelBackgroundTask, getBackgroundTask, registerBackgroundTask } from '../../../shared/background-tasks.mjs';
import { execShellCommand } from './shell-command.mjs';
import { killShellJob, shutdownShellJobs, watchBackgroundShellJob } from './builtin/shell-jobs.mjs';
import { backgroundShellBudgetSnapshot } from './builtin/shell-background-budget.mjs';
import { executeTaskTool } from './builtin/task-tool.mjs';
import {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  getNativeTask,
  shutdownNativeSpawnServer,
} from './lib/native-spawn-client.mjs';

const binary = resolve(
  'native/mixdog-spawn/target/debug',
  process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn'
);
const hasBinary = existsSync(binary);
const skipNative = hasBinary ? false : `native spawn test binary not found: ${binary}`;

const base = (extra = {}) => ({
  shell: process.execPath,
  shellArg: '',
  env: process.env,
  cwd: fixtureRoot,
  ...extra,
});
// A long-lived "server": promoted after 200 ms, never exits on its own.
const longJob = (name, extra = {}) =>
  base({
    command: `long ${name}`,
    directArgv: ['-e', 'setTimeout(() => {}, 60000)'],
    timeoutMs: 0,
    autoBackgroundMs: 200,
    backgroundOnTimeout: true,
    ...extra,
  });
const quickJob = (extra = {}) =>
  base({
    command: 'quick',
    directArgv: ['-e', 'console.log("quick-ok")'],
    timeoutMs: 10_000,
    backgroundOnTimeout: false,
    ...extra,
  });

async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  return predicate();
}

function withEnv(values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function stopAll() {
  await shutdownShellJobs('test-cleanup');
}

// The admission deadline timer is unref'd (a live runtime always has a loop);
// keep this test process alive across those waits.
const keepAlive = setInterval(() => {}, 1_000);
if (hasBinary) _setNativeSpawnBinaryForTest(binary);
test.after(async () => {
  clearInterval(keepAlive);
  if (!hasBinary) return;
  await stopAll();
  await shutdownNativeSpawnServer('test-finish').catch(() => {});
  _resetNativeSpawnClientForTest();
});

test('promotion releases the foreground lease: 8 promoted servers leave a 9th call admitted', { skip: skipNative, timeout: 60_000 }, async () => {
  const admission = new ResourceAdmissionController({ env: {}, limits: { maxShells: 8, maxHighLoad: 12 } });
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        execShellCommand(longJob(`server-${i}`, { admission, ownerSessionId: 'sess_lease' }))
      )
    );
    const jobIds = results.map((result) => {
      assert.equal(result.backgrounded, true, result.stderr);
      return result.jobId;
    });
    assert.equal(admission.snapshot().active.shell, 0);
    assert.equal(admission.snapshot().activeLeases.length, 0);
    assert.deepEqual(
      backgroundShellBudgetSnapshot().jobs.map((job) => job.jobId).sort(),
      [...jobIds].sort()
    );
    for (const jobId of jobIds) assert.equal(getNativeTask(jobId)?.status, 'running');

    const started = Date.now();
    const ninth = await execShellCommand(quickJob({ admission, admissionWaitMs: 2_000 }));
    assert.equal(ninth.exitCode, 0, ninth.stderr);
    assert.match(ninth.stdout, /quick-ok/);
    assert.ok(Date.now() - started < 2_000, 'the 9th call was admitted without waiting');

    // Shutdown still kills background jobs, and nothing stays counted.
    const shutdown = await shutdownShellJobs('test');
    assert.ok(shutdown.killed >= 8);
    for (const jobId of jobIds) assert.notEqual(getNativeTask(jobId)?.status, 'running');
    assert.equal(backgroundShellBudgetSnapshot().jobs.length, 0);
    assert.equal(admission.snapshot().active.shell, 0);
  } finally {
    await stopAll();
  }
});

test('the background cap evicts the least-recently-active job and notifies its owner', { skip: skipNative, timeout: 60_000 }, async () => {
  const admission = new ResourceAdmissionController({ env: {}, limits: { maxShells: 8, maxHighLoad: 12 } });
  const restore = withEnv({ MIXDOG_MAX_BACKGROUND_SHELLS: '5', MIXDOG_BACKGROUND_SHELL_MIN_IDLE_MS: '0' });
  const notices = new Map();
  try {
    const jobIds = [];
    // Sequential promotions; the first passed an explicit timeout_ms.
    for (let i = 0; i < 6; i += 1) {
      const result = await execShellCommand(
        longJob(`evict-${i}`, {
          admission,
          ownerSessionId: 'sess_evict',
          explicitTimeout: i === 0,
          backgroundDeadlineMs: i === 0 ? 50_000 : 0,
        })
      );
      assert.equal(result.backgrounded, true, result.stderr);
      // The 6th waited for the slot the eviction freed: no pending notice.
      assert.doesNotMatch(result.backgroundMessage, /budget full/);
      jobIds.push(result.jobId);
      watchBackgroundShellJob(result.jobId, {
        callerSessionId: 'sess_evict',
        notifyFn: (message) => notices.set(result.jobId, String(message)),
      });
    }
    // Recent four (3..6) and the explicit-timeout job (1) are protected: only
    // job 2, the least-recently-active unprotected one, is evicted.
    const evictedId = jobIds[1];
    assert.equal(backgroundShellBudgetSnapshot().jobs.length, 5, 'the cap holds');
    const notice = await until(() => notices.get(evictedId));
    assert.ok(notice, 'the evicted job owner was notified');
    assert.match(notice, new RegExp(`task-id.*${evictedId}`));
    assert.match(notice, /status.*failed/);
    assert.match(notice, /evicted by the background shell budget/);
    assert.equal(getNativeTask(jobIds[0])?.status, 'running', 'explicit-timeout job protected');
    for (const jobId of jobIds.slice(2)) assert.equal(getNativeTask(jobId)?.status, 'running');
    assert.equal(notices.size, 1);
    assert.equal(admission.snapshot().active.shell, 0);
  } finally {
    restore();
    await stopAll();
  }
  assert.equal(backgroundShellBudgetSnapshot().jobs.length, 0);
});

test('a full cap of protected jobs keeps the new job on its foreground lease and names the caller\u2019s jobs', { skip: skipNative, timeout: 60_000 }, async () => {
  const admission = new ResourceAdmissionController({ env: {}, limits: { maxShells: 8, maxHighLoad: 12 } });
  const restore = withEnv({ MIXDOG_MAX_BACKGROUND_SHELLS: '2' });
  try {
    const first = await execShellCommand(longJob('cap-0', { admission, ownerSessionId: 'sess_cap' }));
    const second = await execShellCommand(
      longJob('cap-1 --token=SECRET-OTHER', { admission, ownerSessionId: 'sess_other' })
    );
    const third = await execShellCommand(longJob('cap-2', { admission, ownerSessionId: 'sess_cap' }));
    for (const result of [first, second, third]) assert.equal(result.backgrounded, true, result.stderr);
    assert.match(third.backgroundMessage, /background shell budget full \(2\/2\)/);
    assert.match(third.backgroundMessage, new RegExp(`task ${third.jobId} keeps its foreground execution slot`));
    assert.match(third.backgroundMessage, new RegExp(`task cancel task_id=${first.jobId}`));
    assert.match(third.backgroundMessage, /1 background job\(s\) belong to other sessions/);
    assert.doesNotMatch(third.backgroundMessage, /SECRET-OTHER/);
    assert.equal(backgroundShellBudgetSnapshot().jobs.length, 2, 'the hard cap is not exceeded');
    assert.equal(admission.snapshot().active.shell, 1, 'the waiting job still holds its foreground lease');
    assert.equal(getNativeTask(third.jobId)?.status, 'running');

    // Cancelling an owned job frees a slot: the waiter moves in and its lease returns.
    killShellJob(first.jobId);
    assert.ok(await until(() => admission.snapshot().active.shell === 0));
    assert.ok(backgroundShellBudgetSnapshot().jobs.some((job) => job.jobId === third.jobId));
  } finally {
    restore();
    await stopAll();
  }
  assert.equal(admission.snapshot().active.shell, 0);
  assert.equal(backgroundShellBudgetSnapshot().jobs.length + backgroundShellBudgetSnapshot().pending.length, 0);
});

test('a queued saturated command releases its lease when it is promoted', { skip: skipNative, timeout: 60_000 }, async () => {
  const admission = new ResourceAdmissionController({ env: {}, limits: { maxShells: 1, maxHighLoad: 12 } });
  try {
    const holder = await admission.acquire('shell', { label: 'holder' });
    const queued = await execShellCommand(
      longJob('queued', { admission, admissionWaitMs: 300, ownerSessionId: 'sess_queue' })
    );
    assert.equal(queued.backgrounded, true);
    const taskId = /task_id: (\S+?)\]/.exec(queued.backgroundMessage)?.[1];
    assert.ok(taskId, queued.backgroundMessage);
    await holder.release();
    // It starts, then promotes under the queued task's own id.
    assert.ok(await until(() => backgroundShellBudgetSnapshot().jobs.some((job) => job.jobId === taskId)));
    assert.equal(admission.snapshot().active.shell, 0);
    assert.equal(getNativeTask(taskId)?.status, 'running');
    const task = getBackgroundTask(taskId);
    assert.equal(task.status, 'running');

    const next = await execShellCommand(quickJob({ admission, admissionWaitMs: 2_000 }));
    assert.equal(next.exitCode, 0, next.stderr);

    cancelBackgroundTask(taskId, 'test');
    await task.promise;
    assert.equal(task.status, 'cancelled');
    assert.ok(await until(() => getNativeTask(taskId)?.status !== 'running'));
    assert.ok(await until(() => backgroundShellBudgetSnapshot().jobs.length === 0));
    assert.equal(admission.snapshot().active.shell, 0);
    assert.equal(admission.snapshot().activeLeases.length, 0);
  } finally {
    await stopAll();
  }
});

test('the saturation error names only the caller\u2019s holders, with task ids and exact cancel calls', async () => {
  let clock = 1;
  const admission = new ResourceAdmissionController({
    env: {},
    now: () => clock,
    limits: { maxShells: 2, maxHighLoad: 12 },
  });
  registerBackgroundTask({ taskId: 'job_mine_1', surface: 'shell', context: { callerSessionId: 'sess_me' } });
  const other = await admission.acquire('shell', {
    label: '[task_id: job_other_1] curl -H "Authorization: Bearer FAKE-TOKEN-123" api',
    ownerKey: 'sess_other',
  });
  clock = 1_001;
  const mine = await admission.acquire('shell', { label: '[task_id: job_mine_1] npm run dev', ownerKey: 'sess_me' });
  clock = 61_001;
  try {
    const result = await execShellCommand(
      quickJob({ admission, admissionWaitMs: 200, ownerSessionId: 'sess_me' })
    );
    assert.equal(result.failureReason, 'resource pressure');
    const text = result.stderr;
    assert.match(text, /shell admission wait exceeded 200ms — 2\/2 shell leases active/);
    assert.match(text, /Your holders, oldest first: \[60s\] \[task_id: job_mine_1\] npm run dev\./);
    assert.match(text, /Free your own slots: task cancel task_id=job_mine_1\./);
    assert.match(text, /1 holder\(s\) belong to other sessions of this runtime \(ages 61s\)/);
    // Another session's holder is a count and an age, never its command.
    assert.doesNotMatch(text, /FAKE-TOKEN-123|curl|job_other_1|sess_other/);
  } finally {
    await other.release();
    await mine.release();
    cancelBackgroundTask('job_mine_1', 'test');
  }
  assert.equal(admission.snapshot().active.shell, 0);
});

test('task list shows other sessions\u2019 shell holders as a read-only count', async () => {
  const lease = await resourceAdmission.acquire('shell', {
    label: '[task_id: job_x] server --password=FAKE-TOKEN-456',
    ownerKey: 'sess_someone',
  });
  try {
    const listed = await executeTaskTool({ action: 'list' }, { sessionId: 'sess_viewer' });
    assert.match(listed, /\[other sessions in this runtime\] 1 foreground shell lease\(s\), 0 background shell job\(s\)/);
    assert.doesNotMatch(listed, /FAKE-TOKEN-456|job_x|sess_someone/);
    const own = await executeTaskTool({ action: 'list' }, { sessionId: 'sess_someone' });
    assert.doesNotMatch(own, /other sessions in this runtime/);
  } finally {
    await lease.release();
  }
});
