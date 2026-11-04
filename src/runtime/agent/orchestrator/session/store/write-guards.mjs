/**
 * Module-level map tracking per-session cancellation generations, commit locks
 * and the highest save epoch that actually LANDED for the id. All three live
 * in one SharedArrayBuffer per id, so the save worker (which receives the
 * buffer inside the write guard) observes the same state as the parent.
 */
import { threadId } from 'node:worker_threads';

const _writeControls = new Map();

// The commit-lock word holds its holder's owner token, never a bare 1: a
// thread terminated inside its commit never runs its release, and only a word
// naming that exact thread may be freed for it once it has exited
// (releaseExitedOwnerCommits). Thread ids are unique for the process's life.
const ownerToken = (ownerThreadId) => ownerThreadId + 1;
const OWN_TOKEN = ownerToken(threadId);

// Layout of the per-id SharedArrayBuffer:
//   int32  [0] cancellation generation (equality-compared, wrap-safe)
//   int32  [1] commit lock: 0 free, else the holder's owner token
//   int64  @8 highest LANDED save epoch — 64-bit and 8-byte aligned so the
//             fence can never wrap or read back negative, unlike an int32
//             slot which a long-lived process could in principle overflow.
const CONTROL_I32_LENGTH = 2;
const LANDED_EPOCH_BYTE_OFFSET = 8;
const CONTROL_BYTES = LANDED_EPOCH_BYTE_OFFSET + BigInt64Array.BYTES_PER_ELEMENT;

function writeControl(id) {
  let control = _writeControls.get(id);
  if (!control) {
    control = new Int32Array(new SharedArrayBuffer(CONTROL_BYTES), 0, CONTROL_I32_LENGTH);
    _writeControls.set(id, control);
  }
  return control;
}

// Both realms build this view over the SAME SharedArrayBuffer they received in
// the guard, so parent and save worker observe one landed-epoch value.
function landedEpochView(buffer) {
  return new BigInt64Array(buffer, LANDED_EPOCH_BYTE_OFFSET, 1);
}

export function guardedSaveOptions(id, opts, epoch = null) {
  const control = writeControl(id);
  // Only exact integers may fence a commit; anything else is treated as
  // "no identity" rather than silently truncated.
  const issued = Number.isSafeInteger(epoch) ? epoch : null;
  return {
    ...(opts || {}),
    _sessionWriteGuard: {
      buffer: control.buffer,
      version: Atomics.load(control, 0),
      // Identity of the snapshot this write carries. Absent for the
      // lifecycle barriers (tombstone/detach/delete), which are
      // authoritative by construction and never epoch-fenced.
      ...(issued === null ? {} : { epoch: issued }),
    },
  };
}

/**
 * Drop the id's control buffer once the session is gone (close/forget/delete)
 * so the map does not grow by one SharedArrayBuffer per session ever saved.
 * Kept while a commit holds the lock: that write still serialises on this
 * buffer. A later save for the same id simply allocates a fresh control.
 */
export function releaseSessionWriteControl(id) {
  const control = _writeControls.get(id);
  if (!control || Atomics.load(control, 1) !== 0) return false;
  return _writeControls.delete(id);
}

export function _hasSessionWriteControl(id) {
  return _writeControls.has(id);
}

export function cancelSessionWrites(id) {
  Atomics.add(writeControl(id), 0, 1);
}

export function isCancelledWrite(opts) {
  const guard = opts?._sessionWriteGuard;
  if (!guard?.buffer || !Number.isInteger(guard.version)) return false;
  try {
    return Atomics.load(new Int32Array(guard.buffer), 0) !== guard.version;
  } catch {
    return true;
  }
}

/**
 * Publish the epoch of a write that just renamed onto the canonical path.
 * Monotonic max, so a late/older commit can never lower the bar.
 */
export function publishLandedWriteEpoch(opts, epoch) {
  const guard = opts?._sessionWriteGuard;
  if (!guard?.buffer || !Number.isSafeInteger(epoch)) return;
  try {
    const view = landedEpochView(guard.buffer);
    const next = BigInt(epoch);
    let current = Atomics.load(view, 0);
    while (next > current) {
      const previous = Atomics.compareExchange(view, 0, current, next);
      if (previous === current) return;
      current = previous;
    }
  } catch {
    /* buffer gone: nothing to fence */
  }
}

/**
 * True when a STRICTLY NEWER save already landed on disk for this id, i.e.
 * committing this snapshot would revert durable history. Covers the exit
 * drain of an outstanding older payload and an older worker write finishing
 * after a newer write (the commit lock serialises renames, it does
 * not order them by content age).
 */
export function isStaleWriteEpoch(opts) {
  const guard = opts?._sessionWriteGuard;
  if (!guard?.buffer || !Number.isSafeInteger(guard.epoch)) return false;
  try {
    return BigInt(guard.epoch) < Atomics.load(landedEpochView(guard.buffer), 0);
  } catch {
    return false;
  }
}

/**
 * Sentinel returned when `timeoutMs` elapsed before the id's commit lock could
 * be taken. Distinct from `false` (cancelled): nothing is wrong with the
 * write, this realm simply may not block any longer (exit drain).
 */
export const WRITE_COMMIT_TIMEOUT = Symbol('session-write-commit-timeout');

/**
 * Sentinel returned when a newer write for the id landed while this one waited
 * for the lock: the caller must discard its scratch file and commit nothing.
 */
export const WRITE_COMMIT_STALE = Symbol('session-write-commit-stale');

// Absolute deadline for an optional non-negative `timeoutMs` (Infinity when absent).
function _lockDeadline(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Date.now() + timeoutMs : Infinity;
}

// One bounded Atomics.wait on the commit-lock slot, never past the deadline.
function _waitLockSlice(control, deadline) {
  const holder = Atomics.load(control, 1);
  if (holder === 0) return;
  const slice = deadline === Infinity ? 25 : Math.min(25, Math.max(1, deadline - Date.now()));
  Atomics.wait(control, 1, holder, slice);
}

/**
 * Sentinel returned by tryAcquireWriteCommit while another commit holds the
 * id's lock. Nothing was taken: the caller waits for that commit's release
 * (writeCommitSettled) and runs its whole attempt again.
 */
export const WRITE_COMMIT_BUSY = Symbol('session-write-commit-busy');

// Resolves once the lock slot reads free; the release's Atomics.notify wakes
// it, and a release that already happened is seen by the load.
async function _untilCommitReleased(control) {
  for (let holder = Atomics.load(control, 1); holder !== 0; holder = Atomics.load(control, 1)) {
    await _untilHolderMoves(control, holder);
  }
}

// Waits on a commit, by the holder's owner token. A holder that turns out to
// be a save worker terminated inside its commit, whose exit is overdue, has
// them answered with rejectCommitWaiters instead of left waiting forever.
const _commitWaiters = new Map(); // token → Set<reject>
let _onCommitWaiter = null;

/** Register the listener told the owner thread id of each new commit wait. */
export function onCommitWaiter(listener) {
  _onCommitWaiter = listener;
}

function _untilHolderMoves(control, holder) {
  const waiting = Atomics.waitAsync(control, 1, holder);
  if (!waiting.async) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let waiters = _commitWaiters.get(holder);
    if (!waiters) _commitWaiters.set(holder, (waiters = new Set()));
    const settle = (finish) => (value) => {
      waiters.delete(fail);
      if (waiters.size === 0 && _commitWaiters.get(holder) === waiters) _commitWaiters.delete(holder);
      finish(value);
    };
    const fail = settle(reject);
    waiters.add(fail);
    waiting.value.then(settle(resolve));
    _onCommitWaiter?.(holder - 1);
  });
}

/** Whether anything waits on a commit lock `ownerThreadId` holds. */
export function hasCommitWaiters(ownerThreadId) {
  return _commitWaiters.has(ownerToken(ownerThreadId));
}

/** Reject every wait on a commit lock `ownerThreadId` holds; the locks stay held. */
export function rejectCommitWaiters(ownerThreadId, err) {
  for (const fail of [...(_commitWaiters.get(ownerToken(ownerThreadId)) ?? [])]) fail(err);
}

// The lock was just taken: refuse a cancelled write and one a newer landed
// write made stale while it waited, both checked UNDER the lock.
function _heldWriteCommit(opts, control) {
  if (isCancelledWrite(opts)) {
    releaseWriteCommit(control);
    return false;
  }
  // Re-checked UNDER the lock: the newer write may have landed while this
  // one was waiting for it.
  if (isStaleWriteEpoch(opts)) {
    releaseWriteCommit(control);
    return WRITE_COMMIT_STALE;
  }
  return control;
}

/**
 * Blocking acquisition, for a realm that may wait on its thread: the save
 * worker, and the exit drain with its bounded `timeoutMs`. The main thread
 * otherwise takes the lock with tryAcquireWriteCommit.
 */
export function acquireWriteCommit(opts, options = {}) {
  const guard = opts?._sessionWriteGuard;
  if (!guard?.buffer) return null;
  const control = new Int32Array(guard.buffer);
  const deadline = _lockDeadline(options.timeoutMs);
  while (Atomics.compareExchange(control, 1, 0, OWN_TOKEN) !== 0) {
    if (Date.now() >= deadline) return WRITE_COMMIT_TIMEOUT;
    _waitLockSlice(control, deadline);
  }
  return _heldWriteCommit(opts, control);
}

/** One compare-exchange, never a wait: WRITE_COMMIT_BUSY while another commit
 *  holds the lock, else exactly what acquireWriteCommit returns. */
export function tryAcquireWriteCommit(opts) {
  const guard = opts?._sessionWriteGuard;
  if (!guard?.buffer) return null;
  const control = new Int32Array(guard.buffer);
  if (Atomics.compareExchange(control, 1, 0, OWN_TOKEN) !== 0) return WRITE_COMMIT_BUSY;
  return _heldWriteCommit(opts, control);
}

/** Give back a commit lock this thread holds (a word naming another owner is
 *  never touched). */
export function releaseWriteCommit(control) {
  if (!control) return;
  if (Atomics.compareExchange(control, 1, OWN_TOKEN, 0) === OWN_TOKEN) Atomics.notify(control, 1);
}

/**
 * Free the commit locks among `buffers` (write-guard buffers) still held by
 * the thread `ownerThreadId`, which has EXITED: it was terminated inside its
 * commit and never ran its release. Only a word naming exactly that thread is
 * reset, so a lock any live thread holds is never touched. Returns how many
 * were freed.
 */
export function releaseExitedOwnerCommits(buffers, ownerThreadId) {
  const token = ownerToken(ownerThreadId);
  let freed = 0;
  for (const buffer of new Set(buffers)) {
    const control = new Int32Array(buffer, 0, CONTROL_I32_LENGTH);
    if (Atomics.compareExchange(control, 1, token, 0) !== token) continue;
    Atomics.notify(control, 1);
    freed++;
  }
  return freed;
}

/**
 * Settles once no commit holds this id's rename lock: null when none holds it
 * now, else a promise resolved by that commit's own release (its
 * Atomics.notify, through Atomics.waitAsync) — the thread never waits. It
 * rejects (ESAVEWORKERHUNG) when the holder is a terminated save worker whose
 * exit did not come within the hung bound; the lock stays held.
 */
export function writeCommitSettled(id) {
  const control = _writeControls.get(id);
  if (!control || Atomics.load(control, 1) === 0) return null;
  return _untilCommitReleased(control);
}

/**
 * Wait until no commit holds this id's rename lock. `timeoutMs` bounds the
 * wait: the exit drain must never hang behind a worker/thread that is stuck
 * inside its commit, and a timeout is safe — the caller's own write still
 * serialises on the same Atomics lock. Returns true when the lock was
 * observed free, false on timeout.
 */
export function waitForWriteCommit(id, opts = {}) {
  const control = writeControl(id);
  const deadline = _lockDeadline(opts.timeoutMs);
  while (Atomics.load(control, 1) !== 0) {
    if (Date.now() >= deadline) return false;
    _waitLockSlice(control, deadline);
  }
  return true;
}
