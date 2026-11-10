/**
 * Workspace admission: the turn, command and management leases of a Git
 * repository (activity-ledger.mjs keeps their ledger). One admission thread
 * per process (activity-ledger-worker.mjs) owns every lease the process holds
 * and runs the ledger's locked read-modify-publish, one request at a time in
 * the order the requests were made. The fsynced writes therefore never block
 * this thread's event loop, and no two threads of the process ever update the
 * ledger at once.
 *
 * Every request is posted and settles with its outcome; no caller ever
 * blocks its thread on one. A `bounded` request (a management hold, a
 * mid-turn cwd move) waits at most MIXDOG_ADMISSION_SYNC_TIMEOUT_MS: one
 * still running then is reported with an unknown outcome, and a grant it
 * completes afterwards is withdrawn at once. A grant or release is answered
 * only once both copies hold its outcome (or it was refused). If the
 * admission thread stops, every outstanding and later request fails
 * (workspace-admission-unreadable) until the process restarts: it is never
 * restarted, since a ledger lock it held still names this live process. The
 * exit waits (bounded the same way) for the requests already posted, so a
 * release made just before exiting still lands.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { WorktreeError, worktreeRefusal } from './contract.mjs';
import { envMs, LEDGER_SLOTS as SLOT } from './activity-ledger.mjs';

export { isExternalCheckout } from './activity-ledger.mjs';

// The longest a bounded request (or the exit) waits for the admission
// thread, the requests queued ahead of it included: each is bounded by the
// ledger lock timeout (file-lock.mjs, MIXDOG_LOCK_TIMEOUT_MS) and the atomic
// writes' rename retries. A chosen ceiling, not a measurement: reaching it is
// the typed `outcome: 'unknown'` refusal, and MIXDOG_ADMISSION_SYNC_TIMEOUT_MS
// (its name kept from the former synchronous wait) sets it.
const boundMs = () => envMs('MIXDOG_ADMISSION_SYNC_TIMEOUT_MS', 60_000);

// `outcome: 'unknown'`: the request was posted and may have landed.
const unknownOutcome = (details = {}) =>
  worktreeRefusal('workspace-admission-unreadable', { ...details, outcome: 'unknown' });
const stoppedError = (posted) =>
  posted
    ? unknownOutcome({ admission: 'stopped' })
    : worktreeRefusal('workspace-admission-unreadable', { admission: 'stopped' });

let gate = null;

function startGate() {
  if (gate) return gate;
  const slots = new Int32Array(new SharedArrayBuffer(SLOT.COUNT * Int32Array.BYTES_PER_ELEMENT));
  let worker;
  try {
    worker = new Worker(new URL('./activity-ledger-worker.mjs', import.meta.url), {
      env: SHARE_ENV,
      execArgv: [],
      workerData: {
        slots: slots.buffer,
        // Tests only: load the fixed fault hook beside the worker (never shipped).
        faultHook: process.env.MIXDOG_ADMISSION_TEST_FAULT_HOOK === '1',
      },
    });
  } catch (cause) {
    // Nothing ran: the next request tries again.
    throw Object.assign(worktreeRefusal('workspace-admission-unreadable', { admission: 'unavailable' }), { cause });
  }
  const current = { worker, slots, lastId: 0, posted: 0, waiting: new Map(), stopped: null };
  gate = current;
  worker.on('message', (answer) => settleAnswer(current, answer));
  worker.on('error', (error) => stopGate(current, error));
  worker.on('exit', (code) => stopGate(current, new Error(`exit code ${code}`)));
  // Kept alive by outstanding asynchronous requests only (request); after the
  // listeners, since attaching a 'message' listener refs the worker again.
  worker.unref();
  process.on('exit', () => drainOnExit(current));
  return current;
}

function stopGate(current, cause) {
  if (current.stopped) return;
  current.stopped = cause;
  process.stderr.write(
    `[state] the workspace admission thread stopped (${cause?.message ?? cause}); workspace activity is refused until restart\n`
  );
  const waiting = [...current.waiting.values()];
  current.waiting.clear();
  for (const entry of waiting) {
    clearTimeout(entry.timer);
    entry.reject(stoppedError(true));
  }
}

function revive(error) {
  if (error.name === 'WorktreeError') return new WorktreeError(error.code, error.message, error.details);
  const revived = new ({ TypeError, RangeError }[error.name] ?? Error)(error.message);
  if (error.code !== undefined) revived.code = error.code;
  return revived;
}

function forget(current, id) {
  current.waiting.delete(id);
  if (!current.waiting.size) current.worker.unref();
}

/**
 * Posts the request at the call, so it runs after every earlier request of
 * this process. `bounded`: a request still unanswered once the bound passes
 * is rejected with the unknown outcome. Its shared claim decides the race
 * with the answer: whichever of this thread (1) and the admission thread (2)
 * sets it first wins, so a grant completed after the caller gave up is
 * withdrawn by the admission thread before it takes the next request.
 */
function request(op, args, { bounded = false } = {}) {
  let current;
  try {
    current = startGate();
  } catch (error) {
    return Promise.reject(error);
  }
  if (current.stopped) return Promise.reject(stoppedError(false));
  return new Promise((resolve, reject) => {
    current.lastId = current.lastId >= 0x3fffffff ? 1 : current.lastId + 1;
    const id = current.lastId;
    const claim = bounded ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)) : null;
    current.worker.postMessage({ id, op, args, claim: claim?.buffer });
    current.posted = (current.posted + 1) | 0;
    const entry = { resolve, reject, timer: null };
    current.waiting.set(id, entry);
    if (current.waiting.size === 1) current.worker.ref();
    if (claim) {
      entry.timer = setTimeout(() => {
        // Lost: the admission thread claimed it and its answer is on the way.
        if (Atomics.compareExchange(claim, 0, 0, 1) !== 0) return;
        forget(current, id);
        reject(unknownOutcome());
      }, boundMs());
    }
  });
}

function settleAnswer(current, { id, value, error }) {
  const entry = current.waiting.get(id);
  if (!entry) return;
  forget(current, id);
  clearTimeout(entry.timer);
  if (error) entry.reject(revive(error));
  else entry.resolve(value);
}

// `exit` listeners run synchronously while the admission thread still runs:
// the requests already posted (a release made just before exiting) are let
// finish. Not a durability mechanism — every grant was answered only once it
// was written — and a forced termination skips it: a release then left
// behind belongs to a dead pid, which the next reader drops.
function drainOnExit(current) {
  const { slots } = current;
  const deadline = Date.now() + boundMs();
  for (;;) {
    const done = Atomics.load(slots, SLOT.DONE);
    if (done === current.posted || current.stopped || Atomics.load(slots, SLOT.STOPPED) === 1) return;
    const left = deadline - Date.now();
    if (left <= 0) return;
    Atomics.wait(slots, SLOT.DONE, done, left);
  }
}

const handled = (promise) => {
  promise.catch(() => {});
  return promise;
};

/**
 * The release of a grant, requested at the call (so it lands before any
 * later request of this process). Settles once the removal was attempted
 * (one that did not land is retried by the admission thread, as always);
 * rejects only when the admission thread stopped. Every call returns the
 * same promise, which never goes unhandled.
 */
function asyncRelease(leases) {
  let released = null;
  return () => (released ??= leases.length ? handled(request('release', { leases })) : Promise.resolve());
}

function readerArgs(sessionId, cwd, { pid = process.pid, kind = 'turn' } = {}) {
  if (!['turn', 'command'].includes(kind)) throw new TypeError('Invalid workspace reader kind.');
  return { sessionId, cwd, pid, kind };
}

/**
 * Readers share a checkout freely. Null means a management writer currently
 * owns it; a reader in an external checkout is admitted whatever is held
 * outside that checkout, but refused by a management lease inside it. Throws
 * `workspace-admission-unreadable` when the ledger cannot be read, was
 * written by a newer build, or the grant could not be made durable in both
 * copies: no work may run unrecorded. `bounded`: the unknown outcome once
 * the admission bound passes unanswered (request). Its release settles once
 * the removal was attempted.
 */
export async function tryAdmitWorkspaceActivityAsync(sessionId, cwd, { bounded = false, ...options } = {}) {
  const granted = await request('admit', readerArgs(sessionId, cwd, options), { bounded });
  return granted && asyncRelease(granted.leases);
}

/** Waits (polling) until a reader is admitted; an abort registers nothing. Its release is asynchronous. */
export async function admitWorkspaceActivity(sessionId, cwd, signal, options) {
  for (;;) {
    signal?.throwIfAborted();
    const leave = await tryAdmitWorkspaceActivityAsync(sessionId, cwd, options);
    if (leave) {
      if (signal?.aborted) {
        try {
          await leave();
        } finally {
          signal.throwIfAborted();
        }
      }
      return leave;
    }
    await delay(100, undefined, { signal });
  }
}

/**
 * Writers refuse while any process's reader overlaps an affected folder, then
 * exclude later readers until the returned release is called. External
 * checkouts are only checked, never held. `sessionId`: the acting session,
 * whose own readers in this process do not count (its idleness is the
 * caller's check). `bounded` as for tryAdmitWorkspaceActivityAsync. Its
 * release settles once every removal was attempted.
 */
export async function holdWorkspaceActivityAsync(folders, { sessionId = null, bounded = false } = {}) {
  return asyncRelease((await request('hold', { folders: [...folders], sessionId }, { bounded })).leases);
}

/**
 * Runs every release in reverse order, each settled before the next, even
 * when one fails; the first failure is rethrown after all ran.
 */
export async function releaseAll(releases) {
  let failure = null;
  for (const done of [...releases].reverse()) {
    try {
      await done();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}
