// Another thread inside its commit of a session, for tests: a Worker takes
// the commit lock in the session's shared control buffer, as the save worker
// does across its rename, and lets it go when asked — or on its own deadline,
// since a main thread blocked on the lock could never ask.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { guardedSaveOptions } from './write-guards.mjs';

// Longer than a save's own scratch write, so the probe is due while the
// operation waits on the lock; far below the holder's own deadline.
const PROBE_MS = 400;
const LATE_MS = 1000;
const HOLDER_DEADLINE_MS = 5000;

const HOLDER = `
const { parentPort, workerData } = require('node:worker_threads');
const control = new Int32Array(workerData.buffer, 0, 2);
if (Atomics.compareExchange(control, 1, 0, 1) !== 0) throw new Error('commit lock already held');
const release = () => {
  Atomics.store(control, 1, 0);
  Atomics.notify(control, 1);
  process.exit(0);
};
const deadline = setTimeout(release, workerData.deadlineMs);
parentPort.once('message', () => {
  clearTimeout(deadline);
  release();
});
parentPort.postMessage('held');
`;

async function holdCommitLock(id) {
  const buffer = guardedSaveOptions(id)._sessionWriteGuard.buffer;
  const worker = new Worker(HOLDER, { eval: true, workerData: { buffer, deadlineMs: HOLDER_DEADLINE_MS } });
  await once(worker, 'message');
  const exited = once(worker, 'exit');
  return {
    release: () => {
      worker.postMessage('release');
      return exited;
    },
  };
}

/**
 * Start `operation` while another thread holds `id`'s commit lock: a timer
 * scheduled with it fires on time while it waits, it has not settled when the
 * lock is let go, and it settles after. Resolves the operation's value.
 */
export async function underHeldCommit(id, operation) {
  const holder = await holdCommitLock(id);
  const scheduledAt = performance.now();
  const probe = new Promise((resolve) => setTimeout(() => resolve(performance.now() - scheduledAt), PROBE_MS));
  let settledAt = null;
  const settled = Promise.resolve()
    .then(operation)
    .then((value) => {
      settledAt = performance.now();
      return value;
    });
  const firedAfter = await probe;
  assert.ok(firedAfter < LATE_MS, `a ${PROBE_MS} ms timer fired after ${Math.round(firedAfter)} ms`);
  assert.equal(settledAt, null, 'it did not land while the other commit held the lock');
  const releasedAt = performance.now();
  await holder.release();
  const value = await settled;
  assert.ok(settledAt >= releasedAt, 'it landed after the lock was let go');
  return value;
}
