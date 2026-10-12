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
import { shutdownShellJobs } from './builtin/shell-jobs.mjs';
import { executeTaskTool } from './builtin/task-tool.mjs';
import {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  getNativeTask,
  listNativeTasks,
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

const runningJobs = () => listNativeTasks().filter((task) => task.status === 'running');

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

test('promotion releases the foreground lease: 8+ background servers leave a 9th call admitted', {
  skip: skipNative,
  timeout: 60_000,
}, async () => {
  const admission = new ResourceAdmissionController({ env: {}, limits: { maxShells: 8, maxHighLoad: 12 } });
  try {
    // Two waves: more background jobs than foreground slots, with no cap.
    const results = [];
    for (const wave of [0, 1]) {
      results.push(
        ...(await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            execShellCommand(longJob(`server-${wave}-${i}`, { admission, ownerSessionId: 'sess_lease' }))
          )
        ))
      );
    }
    const jobIds = results.map((result) => {
      assert.equal(result.backgrounded, true, result.stderr);
      return result.jobId;
    });
    assert.equal(jobIds.length, 12);
    assert.equal(admission.snapshot().active.shell, 0);
    assert.equal(admission.snapshot().activeLeases.length, 0);
    for (const jobId of jobIds) assert.equal(getNativeTask(jobId)?.status, 'running');

    const started = Date.now();
    const ninth = await execShellCommand(quickJob({ admission, admissionWaitMs: 2_000 }));
    assert.equal(ninth.exitCode, 0, ninth.stderr);
    assert.match(ninth.stdout, /quick-ok/);
    assert.ok(Date.now() - started < 2_000, 'the 9th call was admitted without waiting');

    // Shutdown still kills background jobs, and nothing stays counted.
    const shutdown = await shutdownShellJobs('test');
    assert.ok(shutdown.killed >= 12);
    assert.deepEqual(shutdown.unconfirmedJobs, []);
    for (const jobId of jobIds) assert.notEqual(getNativeTask(jobId)?.status, 'running');
    assert.deepEqual(runningJobs(), []);
    assert.equal(admission.snapshot().active.shell, 0);
    assert.equal(admission.snapshot().activeLeases.length, 0);
  } finally {
    await stopAll();
  }
});

test('a scoped parent always resumes: maxHighLoad=1 with many background jobs', {
  skip: skipNative,
  timeout: 60_000,
}, async () => {
  const admission = new ResourceAdmissionController({
    env: {},
    limits: { maxAgents: 1, maxShells: 8, maxHighLoad: 1 },
  });
  const agent = await admission.acquire('agent', { label: 'parent agent', ownerKey: 'sess_parent' });
  try {
    const jobIds = [];
    await admission.runWithLease(agent, async () => {
      for (let i = 0; i < 4; i += 1) {
        // The shell takes the only high-load slot from the suspended parent;
        // promotion must hand it back or this call never returns.
        let timer;
        const result = await Promise.race([
          execShellCommand(longJob(`parent-${i}`, { admission, ownerSessionId: 'sess_parent' })),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('parent never resumed')), 10_000);
          }),
        ]).finally(() => clearTimeout(timer));
        assert.equal(result.backgrounded, true, result.stderr);
        jobIds.push(result.jobId);
        const snap = admission.snapshot();
        assert.equal(snap.active.agent, 1, 'the parent agent holds its slot again');
        assert.equal(snap.active.shell, 0);
      }
    });
    for (const jobId of jobIds) assert.equal(getNativeTask(jobId)?.status, 'running');
  } finally {
    await agent.release();
    await stopAll();
  }
  assert.equal(admission.snapshot().active.agent + admission.snapshot().active.shell, 0);
  assert.equal(admission.snapshot().activeLeases.length, 0);
});

test('a queued saturated command releases its lease when it is promoted', {
  skip: skipNative,
  timeout: 60_000,
}, async () => {
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
    assert.ok(
      await until(() => getNativeTask(taskId)?.status === 'running' && admission.snapshot().active.shell === 0)
    );
    const task = getBackgroundTask(taskId);
    assert.equal(task.status, 'running');

    const next = await execShellCommand(quickJob({ admission, admissionWaitMs: 2_000 }));
    assert.equal(next.exitCode, 0, next.stderr);

    cancelBackgroundTask(taskId, 'test');
    await task.promise;
    assert.equal(task.status, 'cancelled');
    assert.ok(await until(() => getNativeTask(taskId)?.status !== 'running'));
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
    const result = await execShellCommand(quickJob({ admission, admissionWaitMs: 200, ownerSessionId: 'sess_me' }));
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
    assert.match(
      listed,
      /\[other sessions in this runtime\] 1 foreground shell lease\(s\), 0 background shell job\(s\)/
    );
    assert.doesNotMatch(listed, /FAKE-TOKEN-456|job_x|sess_someone/);
    const own = await executeTaskTool({ action: 'list' }, { sessionId: 'sess_someone' });
    assert.doesNotMatch(own, /other sessions in this runtime/);
  } finally {
    await lease.release();
  }
});
