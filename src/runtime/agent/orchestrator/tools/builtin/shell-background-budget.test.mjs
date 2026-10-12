import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';

// In-memory native task store: the budget only reads task state, subscribes to
// it and cancels through it. A job in `undeliverable` models a cancel that
// reaches no spawn server.
const tasks = new Map();
const events = new EventEmitter();
const cancelled = [];
const undeliverable = new Set();
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
      if (undeliverable.has(jobId)) return null;
      setTask(jobId, 'cancelled');
      return { jobId };
    },
  },
});

const {
  backgroundShellBudgetSnapshot,
  backgroundShellEvictionReason,
  backgroundShellPendingNotice,
  clearBackgroundShellBudget,
  pinBackgroundShellJob,
  registerBackgroundShellJob,
  runBackgroundShellMaintenance,
  setBackgroundShellEvictionFailureHandler,
  touchBackgroundShellJob,
} = await import('./shell-background-budget.mjs');

const MIN = 60_000;
const failures = [];
setBackgroundShellEvictionFailureHandler((info) => failures.push(info));

function reset(maxJobs) {
  clearBackgroundShellBudget();
  tasks.clear();
  cancelled.length = 0;
  failures.length = 0;
  undeliverable.clear();
  process.env.MIXDOG_MAX_BACKGROUND_SHELLS = String(maxJobs);
  delete process.env.MIXDOG_BACKGROUND_SHELL_MIN_IDLE_MS;
}

function promote(jobId, now, options = {}) {
  setTask(jobId);
  return registerBackgroundShellJob(jobId, { ownerSessionId: 'sess_a', command: `cmd ${jobId}`, now, ...options });
}

function fakeLease() {
  return {
    released: 0,
    detached: 0,
    release() {
      this.released += 1;
    },
    detachDependency() {
      this.detached += 1;
    },
  };
}

const ids = (rows) => rows.map((row) => row.jobId);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test.after(() => {
  clearBackgroundShellBudget();
  delete process.env.MIXDOG_MAX_BACKGROUND_SHELLS;
});

test('at the cap the least-recently-active eligible jobs are evicted before the new one is admitted', async () => {
  reset(32);
  const base = Date.now();
  for (let i = 1; i <= 6; i += 1) assert.equal(promote(`job_${i}`, base - (20 - i) * MIN).admitted, true);
  // job_1 is the oldest, but the owner just read it: it is inside the idle window.
  touchBackgroundShellJob('job_1', base - MIN);
  process.env.MIXDOG_MAX_BACKGROUND_SHELLS = '5';
  const lease = fakeLease();
  const outcome = promote('job_7', base, { lease });
  // 7 jobs for 5 slots: two evictions, recent four (4..7) and job_1 protected.
  assert.deepEqual(ids(outcome.evicted), ['job_2', 'job_3']);
  assert.deepEqual(cancelled, ['job_2', 'job_3']);
  assert.match(backgroundShellEvictionReason('job_2'), /evicted by the background shell budget: .*cap of 5/);
  assert.match(backgroundShellEvictionReason('job_2'), /idle 1080s/);
  // Admitted once both evictions were confirmed by their exit events.
  assert.equal(outcome.admitted, true);
  await tick();
  assert.equal(lease.released, 1);
  assert.deepEqual(ids(backgroundShellBudgetSnapshot().jobs).sort(), ['job_1', 'job_4', 'job_5', 'job_6', 'job_7']);
});

test('a full cap of protected jobs is never exceeded: the new job waits holding its lease', async () => {
  reset(3);
  const base = Date.now();
  promote('job_a', base - 60 * MIN, { explicitTimeout: true });
  promote('job_b', base - 60 * MIN);
  promote('job_o', base - 60 * MIN, { ownerSessionId: 'sess_other', command: 'deploy --token=SECRET123' });
  const lease = fakeLease();
  const outcome = promote('job_c', base, { lease });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.evicted, []);
  assert.deepEqual(cancelled, []);
  assert.equal(lease.released, 0);
  const snapshot = backgroundShellBudgetSnapshot();
  assert.equal(snapshot.jobs.length, 3, 'the hard cap holds');
  assert.deepEqual(ids(snapshot.pending), ['job_c']);

  const notice = backgroundShellPendingNotice('job_c', 'sess_a', base);
  assert.match(notice, /background shell budget full \(3\/3\): task job_c keeps its foreground execution slot/);
  assert.match(notice, /\[task_id: job_a\] cmd job_a \(idle 3600s, explicit timeout\)/);
  assert.match(notice, /task cancel task_id=job_a; task cancel task_id=job_b/);
  assert.match(notice, /1 background job\(s\) belong to other sessions/);
  assert.doesNotMatch(notice, /SECRET123|job_o/);

  // A slot frees when an owned job ends: the waiter is admitted, lease returned.
  setTask('job_b', 'completed');
  assert.equal(await outcome.whenAdmitted, true);
  await tick();
  assert.equal(lease.released, 1);
  assert.deepEqual(ids(backgroundShellBudgetSnapshot().jobs).sort(), ['job_a', 'job_c', 'job_o']);
});

test('a job in use by a live reader is never evicted, even when it is the least recently active', () => {
  reset(32);
  const base = Date.now();
  promote('job_pinned', base - 90 * MIN);
  promote('job_idle', base - 60 * MIN);
  for (let i = 1; i <= 4; i += 1) promote(`job_r${i}`, base - 5 * MIN);
  const unpin = pinBackgroundShellJob('job_pinned');
  // Pinning also counts as a read; with no idle window only the pin protects it.
  process.env.MIXDOG_BACKGROUND_SHELL_MIN_IDLE_MS = '0';
  process.env.MIXDOG_MAX_BACKGROUND_SHELLS = '6';
  const outcome = promote('job_new', base, { lease: fakeLease() });
  assert.deepEqual(ids(outcome.evicted), ['job_idle']);
  assert.equal(backgroundShellBudgetSnapshot().jobs.find((job) => job.jobId === 'job_pinned').pinned, true);
  unpin();
  assert.equal(backgroundShellBudgetSnapshot().jobs.find((job) => job.jobId === 'job_pinned').pinned, false);
});

test('jobs inside the minimum idle window are not eligible', () => {
  reset(1);
  const base = Date.now();
  promote('job_x', base - 9 * MIN);
  for (let i = 1; i <= 4; i += 1) promote(`job_r${i}`, base - 5 * MIN);
  const outcome = promote('job_new', base, { lease: fakeLease() });
  assert.deepEqual(outcome.evicted, []);
  assert.equal(outcome.admitted, false);
  // Past the window it becomes eligible on the next maintenance pass.
  const later = runBackgroundShellMaintenance(base + 2 * MIN);
  assert.deepEqual(ids(later), ['job_x']);
});

test('an undelivered eviction keeps the job counted, retries, and reports once', async () => {
  reset(32);
  const base = Date.now();
  promote('job_old', base - 60 * MIN);
  for (let i = 1; i <= 4; i += 1) promote(`job_r${i}`, base - MIN);
  undeliverable.add('job_old');
  process.env.MIXDOG_MAX_BACKGROUND_SHELLS = '5';
  const lease = fakeLease();
  const outcome = promote('job_new', base, { lease });
  assert.deepEqual(ids(outcome.evicted), ['job_old']);
  assert.equal(outcome.admitted, false);
  let snapshot = backgroundShellBudgetSnapshot();
  const old = snapshot.jobs.find((job) => job.jobId === 'job_old');
  assert.equal(old.evicting, true, 'still counted until termination is confirmed');
  assert.match(old.evictFailure, /not delivered/);
  assert.deepEqual(ids(snapshot.pending), ['job_new']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].jobId, 'job_old');
  assert.equal(failures[0].ownerSessionId, 'sess_a');

  runBackgroundShellMaintenance(base + 1000);
  assert.deepEqual(cancelled, ['job_old', 'job_old'], 'retried');
  assert.equal(failures.length, 1, 'reported once');
  assert.equal(backgroundShellBudgetSnapshot().pending.length, 1);

  undeliverable.delete('job_old');
  runBackgroundShellMaintenance(base + 2000);
  assert.equal(await outcome.whenAdmitted, true);
  await tick();
  assert.equal(lease.released, 1);
  snapshot = backgroundShellBudgetSnapshot();
  assert.equal(snapshot.jobs.some((job) => job.jobId === 'job_old'), false);
  assert.equal(snapshot.pending.length, 0);
});

test('budget entries end with their jobs and shutdown returns pending leases', async () => {
  reset(1);
  const base = Date.now();
  promote('job_a', base);
  const lease = fakeLease();
  promote('job_b', base, { lease });
  setTask('job_b', 'failed');
  await tick();
  assert.equal(lease.released, 1, 'a waiter that ended gives its slot back');
  const second = fakeLease();
  promote('job_c', base, { lease: second });
  clearBackgroundShellBudget();
  await tick();
  assert.equal(second.released, 1);
  setTask('job_a', 'completed');
  const snapshot = backgroundShellBudgetSnapshot();
  assert.equal(snapshot.jobs.length + snapshot.pending.length, 0);
  assert.deepEqual(cancelled, []);
});
