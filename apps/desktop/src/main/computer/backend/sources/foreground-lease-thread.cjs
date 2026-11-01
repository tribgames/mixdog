'use strict';
// The bridge host's foreground-lock leases, owned by this worker thread of the
// process hosting the bridge (foreground-lock-host.ts starts it). Windows gives
// LockSetForegroundWindow to a process that may set the foreground: a pooled
// Computer Use worker rarely may, the process the user works in does, and the
// lock then belongs to that process, so this thread both takes and ends it.
// The thread does nothing else (no accessibility call, no wait on any
// acknowledgement), so a lease ends at its deadline on this thread's own clock
// however long the main event loop is blocked. The protection stays best
// effort: Windows also lifts the lock on the user's Alt key or click.
//
// All times are milliseconds on QueryPerformanceCounter, the clock the worker
// reads too (MixForegroundLock.cs), so its deadlines compare across processes.
const { parentPort, workerData } = require('node:worker_threads');

/** No lease holds every other app's foreground changes for longer. */
const MAX_HOLD_MS = 1000;
/** Delays before each further attempt of one unlock that did not succeed. */
const UNLOCK_RETRY_MS = [10, 20, 40];
/** While unlock calls keep failing outright, one more is tried this often. */
const FAILED_RETRY_MS = 1000;
/** Ended leases kept to answer a release that arrives after the end. */
const RECENT_LEASES = 64;

function koffiNative(koffiPath) {
  const koffi = require(koffiPath);
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const getForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const getWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'
  );
  const lockSetForegroundWindow = user32.func('bool __stdcall LockSetForegroundWindow(uint32_t code)');
  const getLastError = kernel32.func('uint32_t __stdcall GetLastError()');
  const queryPerformanceCounter = kernel32.func('bool __stdcall QueryPerformanceCounter(_Out_ int64_t *count)');
  const queryPerformanceFrequency = kernel32.func('bool __stdcall QueryPerformanceFrequency(_Out_ int64_t *frequency)');
  const frequency = [0];
  queryPerformanceFrequency(frequency);
  const ticksPerMs = Number(frequency[0]) / 1000;
  const count = [0];
  return {
    now() {
      queryPerformanceCounter(count);
      return Number(count[0]) / ticksPerMs;
    },
    foregroundProcessId() {
      const window = getForegroundWindow();
      if (!window) return 0;
      const pid = [0];
      getWindowThreadProcessId(window, pid);
      return pid[0];
    },
    lock() {
      const locked = Boolean(lockSetForegroundWindow(1));
      return { locked, error: locked ? 0 : Number(getLastError()) };
    },
    // False when this process does not hold the lock (ReactOS win32k focus.c
    // IntLockSetForegroundWindow), which includes Windows having lifted it.
    unlock() {
      const unlocked = Boolean(lockSetForegroundWindow(2));
      return { unlocked, error: unlocked ? 0 : Number(getLastError()) };
    },
  };
}

let native = null;
let unavailable = '';
try {
  // Tests name a stand-in for user32; the app loads it through koffi.
  native = workerData.nativeModule ? require(workerData.nativeModule)(workerData) : koffiNative(workerData.koffiPath);
} catch (error) {
  unavailable = `user32 could not be loaded on the lease thread: ${String((error && error.message) || error)}`;
}

const round = (value) => (value === undefined ? undefined : Math.round(value * 10) / 10);
const reason = (error) => String((error && error.message) || error);
// The clock, which no step that holds or ends a lock may die of: a call that
// throws gives undefined, recorded on the lease, and a deadline read that way
// counts as reached, so a failing clock ends a lease rather than keeping it.
function clock(held) {
  try {
    return native.now();
  } catch (error) {
    if (held) held.facts.clock_error = reason(error);
    return undefined;
  }
}
function post(message) {
  try {
    parentPort.postMessage(message);
  } catch {
    // An account main cannot receive changes nothing this thread holds.
  }
}
/** Whether this thread may still hold the lock: a lease, or an unlock not yet proven. */
const holding = () => lease !== null || ending !== null || failed !== null;
// A step of the deadline or unlock path runs guarded: one that throws counts
// as an unlock attempt that failed, so the lease stays quarantined and its
// unlock keeps being retried instead of the thread dying with the lock held.
function guarded(held, step) {
  try {
    step();
  } catch (error) {
    held.facts.thread_error = reason(error);
    clearTimeout(held.timer);
    clearTimeout(held.retry);
    if (lease === held) lease = null;
    if (ending === held) ending = null;
    const reported = held.facts.release !== undefined;
    failed = held;
    held.retry = setTimeout(() => guarded(held, () => retryFailed(held)), FAILED_RETRY_MS);
    if (!reported) {
      held.facts.release = 'failed';
      postReleased(held, 'failed', held.replyWanted);
    }
  }
}
let generation = 0;
/** The lease holding the lock. */
let lease = null;
/** A lease whose unlock is still being tried; no new lease starts meanwhile. */
let ending = null;
/** A lease whose unlock calls all failed outright; retried until one answers. */
let failed = null;
const recent = new Map();
const ownerKey = (instance, action, seq) => `${instance}:${action}:${seq}`;

function acquire(request) {
  const facts = { lease: 0, answer: 'unavailable', host_pid: process.pid, worker_pid: request.pid };
  let deadlineAt = 0;
  const receivedAt = native ? clock(null) : undefined;
  if (!native) facts.reason = unavailable;
  else if (receivedAt === undefined) facts.reason = 'the lease clock failed';
  else {
    facts.received_at = round(receivedAt);
    facts.answer_by = round(request.answerBy);
    if (ending || failed) facts.answer = 'quarantined';
    else if (lease) facts.answer = 'busy';
    // The worker stopped waiting: a lock taken now would protect nothing.
    else if (receivedAt >= request.answerBy) facts.answer = 'expired';
    else {
      let result;
      try {
        facts.foreground_pid = native.foregroundProcessId();
        result = native.lock();
      } catch (error) {
        facts.reason = reason(error);
        result = { locked: false };
      }
      if (!result.locked) {
        if (!facts.reason) {
          facts.answer = 'refused';
          facts.error = result.error;
        }
      } else {
        // Immutable from here: no later request extends it.
        const held = {
          id: ++generation,
          instance: request.instance,
          action: request.action,
          seq: request.seq,
          acquiredAt: receivedAt,
          deadlineAt: receivedAt,
          facts,
          timer: null,
          retry: null,
          replyWanted: false,
        };
        lease = held;
        facts.lease = held.id;
        guarded(held, () => {
          const acquiredAt = clock(held);
          if (acquiredAt !== undefined) held.acquiredAt = acquiredAt;
          held.deadlineAt = held.acquiredAt + Math.min(MAX_HOLD_MS, request.holdMs);
          facts.acquired_at = round(held.acquiredAt);
          facts.deadline_at = round(held.deadlineAt);
          // Taken too late for the worker, or with no clock to bound it: ended now.
          if (acquiredAt === undefined || acquiredAt >= request.answerBy) {
            facts.answer = 'expired';
            end(held, 'expired');
          } else {
            facts.answer = 'locked';
            deadlineAt = held.deadlineAt;
            schedule(held);
          }
        });
      }
    }
  }
  post({
    holding: holding(),
    type: 'answer',
    instance: request.instance,
    action: request.action,
    seq: request.seq,
    lease: facts.lease,
    answer: facts.answer,
    deadlineAt,
    facts,
  });
}

// A timer may fire a little early or late; one that fires early waits out the rest.
function schedule(held) {
  const at = clock(held);
  held.timer = setTimeout(
    () =>
      guarded(held, () => {
        if (lease !== held) return;
        const now = clock(held);
        if (now !== undefined && now < held.deadlineAt) {
          schedule(held);
          return;
        }
        held.facts.expired_at = round(now);
        end(held, 'deadline');
      }),
    at === undefined ? 0 : Math.max(0, Math.ceil(held.deadlineAt - at))
  );
}

function end(held, by) {
  if (lease !== held) return;
  lease = null;
  clearTimeout(held.timer);
  ending = held;
  held.facts.released_by = by;
  held.facts.unlock_requested_at = round(clock(held));
  held.facts.unlock_attempts = 0;
  attempt(held, 0);
}

function unlockOnce(held) {
  held.facts.unlock_attempts = (held.facts.unlock_attempts || 0) + 1;
  try {
    const result = native.unlock();
    (held.facts.unlock_errors ??= []).push(result.unlocked ? 0 : result.error);
    return result.unlocked ? 'released' : 'unknown';
  } catch (error) {
    (held.facts.unlock_errors ??= []).push(reason(error));
    return 'failed';
  }
}

// A false unlock says this process no longer holds the lock, which may be
// Windows having lifted it: that is no proof the lease ended here, so it is
// reported as unknown, never as released. A throwing call is failed.
function attempt(held, retries) {
  const outcome = unlockOnce(held);
  if (outcome !== 'released' && retries < UNLOCK_RETRY_MS.length) {
    held.retry = setTimeout(() => guarded(held, () => attempt(held, retries + 1)), UNLOCK_RETRY_MS[retries]);
    return;
  }
  finish(held, outcome);
}

function finish(held, outcome) {
  const endedAt = clock(held);
  const facts = held.facts;
  facts.release = outcome;
  if (endedAt !== undefined) {
    facts.ended_at = round(endedAt);
    facts.held_ms = round(endedAt - held.acquiredAt);
    facts.late_ms = round(endedAt - held.deadlineAt);
  }
  ending = null;
  // A new lease can only begin with a lock Windows grants while no lock is
  // held, so after an unknown end it may; after failed calls it waits for an
  // unlock call that answers at all.
  if (outcome === 'failed') {
    failed = held;
    held.retry = setTimeout(() => guarded(held, () => retryFailed(held)), FAILED_RETRY_MS);
  }
  recent.set(ownerKey(held.instance, held.action, held.seq), held);
  if (recent.size > RECENT_LEASES) recent.delete(recent.keys().next().value);
  postReleased(held, outcome, held.replyWanted);
}

function retryFailed(held) {
  if (failed !== held) return;
  const outcome = unlockOnce(held);
  if (outcome === 'failed') {
    held.retry = setTimeout(() => guarded(held, () => retryFailed(held)), FAILED_RETRY_MS);
    return;
  }
  failed = null;
  held.facts.resolved = outcome;
  held.facts.resolved_at = round(clock(held));
  postReleased(held, held.facts.release, false);
}

function postReleased(held, outcome, reply) {
  post({
    holding: holding(),
    type: 'released',
    instance: held.instance,
    action: held.action,
    seq: held.seq,
    lease: held.id,
    outcome,
    reply,
    facts: held.facts,
  });
}

// Only the request that took a lease ends it: the same worker, action and
// sequence, and the lease itself when the worker knows it. An older request's
// release gets its own lease's outcome and leaves a newer lease alone.
function release(request) {
  const owns = (held) =>
    held !== null &&
    held.instance === request.instance &&
    held.action === request.action &&
    held.seq === request.seq &&
    (request.lease === 0 || request.lease === held.id);
  if (owns(lease)) {
    const held = lease;
    held.replyWanted = true;
    guarded(held, () => {
      held.facts.release_requested_at = round(clock(held));
      end(held, 'worker');
    });
    return;
  }
  if (owns(ending)) {
    ending.replyWanted = true;
    return;
  }
  const ended = recent.get(ownerKey(request.instance, request.action, request.seq));
  if (ended && owns(ended)) {
    postReleased(ended, ended.facts.release, true);
    return;
  }
  // Nothing this request took holds the lock: it was refused or never answered.
  post({
    holding: holding(),
    type: 'released',
    instance: request.instance,
    action: request.action,
    seq: request.seq,
    lease: request.lease,
    outcome: 'none',
    reply: true,
    facts: null,
  });
}

function gone(instance) {
  if (lease && lease.instance === instance) {
    const held = lease;
    guarded(held, () => end(held, 'worker_gone'));
  }
  for (const [key, held] of recent) if (held.instance === instance) recent.delete(key);
}

// The app is going away: one bounded round of unlock calls, then the true end
// state for main, which unlocks itself unless this says released or none.
// Main stops the thread once it has this answer.
function dispose() {
  const held = lease || ending || failed;
  for (const each of [lease, ending, failed]) {
    if (each) {
      clearTimeout(each.timer);
      clearTimeout(each.retry);
    }
  }
  lease = ending = failed = null;
  let outcome = 'none';
  if (held) {
    for (let tries = 0; tries <= UNLOCK_RETRY_MS.length; tries++) {
      outcome = unlockOnce(held);
      if (outcome === 'released') break;
    }
  }
  post({ type: 'disposed', outcome });
}

parentPort.on('message', (message) => {
  try {
    if (message === null || typeof message !== 'object') return;
    if (message.type === 'acquire') acquire(message);
    else if (message.type === 'release') release(message);
    else if (message.type === 'gone') gone(message.instance);
    else if (message.type === 'dispose') dispose();
  } catch {
    // One message that cannot be answered must not end the owner of a held lock.
  }
});
