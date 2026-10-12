import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';

// In-memory native task store: the budget only reads task state, subscribes to
// it and cancels through it.
const tasks = new Map();
const events = new EventEmitter();
const cancelled = [];
function setTask(jobId, status = 'running') {
  const task = { jobId, status, stdoutBytes: 0, stderrBytes: 0 };
  tasks.set(jobId, task);
  events.emit(jobId, { ...task });
}
mock.module('../lib/native-spawn-client.mjs', {
  namedExports: {
    getNativeTask: (jobId) => (tasks.has(jobId) ? { ...tasks.get(jobId) } : null),
    subscribeNativeTask: (jobId, listener) => {
      events.on(jobId, listener);
      return () => events.removeListener(jobId, listener);
    },
    cancelNativeTask: (jobId) => {
      cancelled.push(jobId);
      setTask(jobId, 'cancelled');
      return { jobId };
    },
  },
});

const {
  backgroundShellBudgetSnapshot,
  backgroundShellEvictionReason,
  clearBackgroundShellBudget,
  registerBackgroundShellJob,
  touchBackgroundShellJob,
} = await import('./shell-background-budget.mjs');

function reset(maxJobs) {
  clearBackgroundShellBudget();
  tasks.clear();
  cancelled.length = 0;
  process.env.MIXDOG_MAX_BACKGROUND_SHELLS = String(maxJobs);
}

function promote(jobId, now, options = {}) {
  setTask(jobId);
  return registerBackgroundShellJob(jobId, { ownerSessionId: 'sess_a', command: `cmd ${jobId}`, now, ...options });
}

test.after(() => {
  clearBackgroundShellBudget();
  delete process.env.MIXDOG_MAX_BACKGROUND_SHELLS;
});

test('the cap evicts the least-recently-active unprotected job and records why', () => {
  reset(32);
  for (let i = 1; i <= 6; i += 1) assert.deepEqual(promote(`job_${i}`, i * 1000), []);
  // job_1 is the oldest, but the owner just read it: job_2 and job_3 are LRU.
  touchBackgroundShellJob('job_1', 10_000);
  process.env.MIXDOG_MAX_BACKGROUND_SHELLS = '5';
  const evicted = promote('job_7', 11_000);
  assert.deepEqual(
    evicted.map((row) => row.jobId),
    ['job_2', 'job_3']
  );
  assert.deepEqual(cancelled, ['job_2', 'job_3']);
  assert.equal(evicted[0].ownerSessionId, 'sess_a');
  assert.match(backgroundShellEvictionReason('job_2'), /evicted by the background shell budget: 7 .* cap of 5/);
  assert.match(backgroundShellEvictionReason('job_2'), /idle 9s/);
  // The cancelled jobs left the budget on their exit events.
  assert.deepEqual(
    backgroundShellBudgetSnapshot().jobs.map((job) => job.jobId),
    ['job_1', 'job_4', 'job_5', 'job_6', 'job_7']
  );
});

test('exited jobs leave first; recent and explicit-timeout jobs are never evicted', () => {
  reset(1);
  promote('job_t', 1000, { explicitTimeout: true });
  promote('job_x', 2000);
  // job_x exited without an event reaching the budget: it is dropped, not killed.
  tasks.get('job_x').status = 'completed';
  for (let i = 1; i <= 4; i += 1) assert.deepEqual(promote(`job_r${i}`, 2000 + i * 1000), []);
  const evicted = promote('job_new', 9000);
  assert.deepEqual(evicted.map((row) => row.jobId), ['job_r1']);
  assert.deepEqual(cancelled, ['job_r1']);
  // Only protected jobs remain: the soft cap is exceeded instead of failing.
  assert.deepEqual(
    backgroundShellBudgetSnapshot().jobs.map((job) => job.jobId).sort(),
    ['job_new', 'job_r2', 'job_r3', 'job_r4', 'job_t']
  );
  assert.equal(backgroundShellEvictionReason('job_t'), null);
});

test('budget entries end with their jobs', () => {
  reset(32);
  promote('job_a', 1000);
  promote('job_b', 2000);
  setTask('job_a', 'completed');
  setTask('job_b', 'failed');
  assert.equal(backgroundShellBudgetSnapshot().jobs.length, 0);
  assert.deepEqual(cancelled, []);
});
