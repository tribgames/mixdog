import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';

// In-memory native runner: `survivors` ignore cancellation.
const tasks = new Map();
const events = new EventEmitter();
const survivors = new Set();
const cancels = [];
function setTask(jobId, status, ownerSessionId = 'sess_x') {
  const task = { jobId, status, ownerSessionId, command: `cmd ${jobId}` };
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
      cancels.push(jobId);
      if (!tasks.has(jobId)) return null;
      if (!survivors.has(jobId)) setTask(jobId, 'cancelled', tasks.get(jobId).ownerSessionId);
      return { ...tasks.get(jobId) };
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

const { shutdownShellJobs, shellShutdownSurvivors } = await import('./shell-jobs.mjs');

test('shutdown keeps retrying a survivor until its exit is confirmed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setTask('job_ok', 'running');
  setTask('job_stuck', 'running');
  survivors.add('job_stuck');
  const result = await shutdownShellJobs('test', { scope: { ownerSessionId: 'sess_x' } });
  assert.equal(result.killed, 2);
  assert.deepEqual(result.unconfirmedJobs, ['job_stuck']);
  assert.deepEqual(shellShutdownSurvivors(), [{ jobId: 'job_stuck', attempts: 1 }]);

  // Each interval re-issues the stop while the process is still running.
  t.mock.timers.tick(5_000);
  t.mock.timers.tick(5_000);
  assert.equal(cancels.filter((id) => id === 'job_stuck').length, 3);
  assert.deepEqual(shellShutdownSurvivors(), [{ jobId: 'job_stuck', attempts: 3 }]);

  // Once the exit is confirmed it is dropped.
  setTask('job_stuck', 'cancelled');
  t.mock.timers.tick(5_000);
  assert.deepEqual(shellShutdownSurvivors(), []);
});

test('shutdown retries are bounded and the survivor stays listed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setTask('job_forever', 'running', 'sess_y');
  survivors.add('job_forever');
  await shutdownShellJobs('test', { scope: { ownerSessionId: 'sess_y' } });
  for (let i = 0; i < 20; i += 1) t.mock.timers.tick(5_000);
  assert.equal(cancels.filter((id) => id === 'job_forever').length, 10);
  assert.deepEqual(shellShutdownSurvivors(), [{ jobId: 'job_forever', attempts: 10 }]);
});
