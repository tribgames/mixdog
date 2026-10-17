// Import before runtime modules: shell-job records are written under it.
import '../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';

// In-memory native runner: `survivors` ignore cancellation.
const tasks = new Map();
const events = new EventEmitter();
const survivors = new Set();
const cancels = [];
const ownerCancels = [];
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
    promoteNativeTask: async ({ jobId, ownerSessionId }) => {
      setTask(jobId, 'running', ownerSessionId);
      return { ...tasks.get(jobId) };
    },
    setNativeTaskOutputPaths: noop,
    setNativeTaskStartedAt: noop,
    trackNativeForegroundTask: async () => null,
    cancelNativeTasks: ({ ownerSessionId }) => {
      ownerCancels.push(ownerSessionId);
      return { cancelled: 1, unconfirmed: [], confirmed: true };
    },
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

const { otherSessionBackgroundShellJobCount, promoteForegroundShellJob, shutdownShellJobs, shellShutdownSurvivors } =
  await import('./shell-jobs.mjs');
const { cancelOwnedShellTrees, registerOwnedShellTree } = await import('../lib/owned-shell-trees.mjs');
const { PROCESS_TABLE_READ_BOUND_MS } = await import('../lib/shell-descendants.mjs');

test('runtime shutdown sends a session-close cancel still waiting for its snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // A snapshot read that never answers: the close is waiting on its bound.
  registerOwnedShellTree('job_snapshot_pending', {
    ownerSessionId: 'sess_closing',
    prepareKill: () => new Promise(noop),
  });
  const closing = cancelOwnedShellTrees('sess_closing');
  assert.equal(typeof closing.then, 'function');
  assert.deepEqual(ownerCancels, [], 'the close is still waiting for the snapshot');
  await shutdownShellJobs('runtime-close');
  assert.deepEqual(ownerCancels, ['sess_closing'], 'shutdown sent the kill at once');
  t.mock.timers.tick(PROCESS_TABLE_READ_BOUND_MS);
  assert.deepEqual((await closing).cancelled, 1);
  assert.deepEqual(ownerCancels, ['sess_closing'], 'the kill is sent exactly once');
});

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
  // An exit after the last retry still removes the entry, by its native event.
  setTask('job_forever', 'cancelled', 'sess_y');
  assert.deepEqual(shellShutdownSurvivors(), []);
});

test('listing survivors reconciles an exit whose event was missed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setTask('job_quiet', 'running', 'sess_z');
  survivors.add('job_quiet');
  await shutdownShellJobs('test', { scope: { ownerSessionId: 'sess_z' } });
  assert.deepEqual(shellShutdownSurvivors(), [{ jobId: 'job_quiet', attempts: 1 }]);
  tasks.get('job_quiet').status = 'cancelled'; // no event emitted
  assert.deepEqual(shellShutdownSurvivors(), []);
});

test('a promoted job leaves the other-session count when it settles', async () => {
  const mine = new Set(['sess_me']);
  setTask('job_p', 'running', 'sess_other');
  await promoteForegroundShellJob({ command: 'serve', cwd: '.', pid: 0, jobId: 'job_p', ownerSessionId: 'sess_other' });
  assert.equal(otherSessionBackgroundShellJobCount(mine), 1);
  setTask('job_p', 'cancelled', 'sess_other');
  // Revive the state silently: a still-tracked id would be counted again.
  tasks.get('job_p').status = 'running';
  assert.equal(otherSessionBackgroundShellJobCount(mine), 0, 'removed on settlement, not on count');
  tasks.delete('job_p');
});
