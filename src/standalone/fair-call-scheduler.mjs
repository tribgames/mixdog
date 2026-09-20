import { positiveInt } from '../runtime/shared/numbers.mjs';
import { abortError, detach, schedulerError } from './fair-call-scheduler/queue-item.mjs';
import { createOwnerGroups } from './fair-call-scheduler/owner-groups.mjs';

function activeLimit(value, fallback) {
  if (value === null || value === Infinity) return Infinity;
  return positiveInt(value, fallback);
}

/**
 * Owner-fair async dispatcher with an optional active limit.
 *
 * One owner may borrow the entire queue while it is alone. When another owner
 * appears, new admissions are divided by weight and a completely full queue
 * evicts one tail item from the largest borrower so the newcomer always gets a
 * seat. Running work is never revoked. Per-owner queues and the fairness
 * arithmetic live in fair-call-scheduler/owner-groups.
 */
export function createFairCallScheduler({
  name = 'daemon call',
  activeMax = 32,
  queueMax = 256,
  minOwnerQueue = 8,
  dispatchBurst = 8,
  yieldUnbounded = false,
  schedule = setImmediate,
  now = Date.now,
} = {}) {
  const maxActive = activeLimit(activeMax, 32);
  const maxQueued = positiveInt(queueMax, 256);
  const ownerFloor = Math.max(1, Math.min(maxQueued, positiveInt(minOwnerQueue, 8)));
  const maxBurst = positiveInt(dispatchBurst, 8);
  const groups = createOwnerGroups({ maxQueued, ownerFloor });
  const state = { active: 0, queued: 0, scheduled: false, closed: false, closeError: null };

  function dequeued() {
    state.queued = Math.max(0, state.queued - 1);
  }

  function rejectBorrowedTail(incoming) {
    const borrower = groups.largestBorrower(incoming);
    if (!borrower) return false;
    const displaced = borrower.queue.pop();
    dequeued();
    detach(displaced);
    displaced.reject(
      schedulerError(`${name} queue rebalanced for another client; retry after running work completes`, 503)
    );
    groups.maybeDeleteGroup(borrower);
    return true;
  }

  function runAdmitted(run, signal) {
    // Admission reserves capacity, but invocation occurs in a later microtask.
    // Recheck that boundary without revoking work that has already started.
    if (signal?.aborted) throw abortError(signal);
    if (state.closed) throw state.closeError;
    return run();
  }

  /**
   * Occupy an active slot for `group` while `run` executes, hand the outcome
   * to `settle` when the call was queued, then release the slot and re-dispatch.
   */
  function occupy(group, run, signal, settle = null) {
    state.active += 1;
    group.active += 1;
    let outcome = Promise.resolve().then(() => runAdmitted(run, signal));
    if (settle) outcome = outcome.then(settle.resolve, settle.reject);
    return outcome.finally(() => {
      state.active = Math.max(0, state.active - 1);
      group.active = Math.max(0, group.active - 1);
      groups.maybeDeleteGroup(group);
      scheduleDispatch();
    });
  }

  function dispatch() {
    state.scheduled = false;
    let started = 0;
    while (!state.closed && state.active < maxActive && state.queued > 0 && started < maxBurst) {
      const group = groups.pickGroup();
      const item = group?.queue.shift();
      if (!group || !item) break;
      dequeued();
      detach(item);
      started += 1;
      void occupy(group, item.run, item.signal, item);
    }
    // A bounded burst amortizes loopback dispatch without letting synchronous
    // setup monopolize the supervisor's socket/control-plane turn.
    scheduleDispatch();
  }

  function scheduleDispatch() {
    if (state.closed || state.scheduled || state.active >= maxActive || state.queued === 0) return;
    state.scheduled = true;
    schedule(dispatch);
  }

  function admissionError(group) {
    if (groups.hasCompetitor(group) && group.queue.length >= groups.fairQueueLimit(group)) {
      return schedulerError(`${name} client queue is full; retry after this client's running work completes`, 429);
    }
    if (state.queued >= maxQueued && !rejectBorrowedTail(group)) {
      return schedulerError(`${name} queue is full`, 503);
    }
    return null;
  }

  function queueItem(group, run, signal) {
    return new Promise((resolve, reject) => {
      const item = { run, resolve, reject, signal, onAbort: null, queuedAt: now() };
      if (signal) {
        item.onAbort = () => {
          const index = group.queue.indexOf(item);
          if (index < 0) return;
          group.queue.splice(index, 1);
          dequeued();
          detach(item);
          groups.maybeDeleteGroup(group);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', item.onAbort, { once: true });
      }
      group.queue.push(item);
      state.queued += 1;
    });
  }

  function enqueue(owner, run, { weight = 1, signal = null } = {}) {
    if (state.closed) return Promise.reject(schedulerError(`${name} scheduler is closed`));
    if (typeof run !== 'function') return Promise.reject(new TypeError('scheduled call must be a function'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const group = groups.groupFor(owner, weight);
    // Default daemon lanes are unbounded. Do not enqueue them only to bounce
    // through setImmediate: independent loopback calls start in this microtask,
    // while finite operator-configured lanes retain the fair queue below.
    if (maxActive === Infinity && !yieldUnbounded && state.queued === 0) {
      return occupy(group, run, signal);
    }
    const refused = admissionError(group);
    if (refused) {
      groups.maybeDeleteGroup(group);
      return Promise.reject(refused);
    }
    const promise = queueItem(group, run, signal);
    scheduleDispatch();
    return promise;
  }

  function close(reason = `${name} scheduler is closed`) {
    if (state.closed) return;
    state.closed = true;
    const error = schedulerError(reason);
    state.closeError = error;
    for (const group of groups.all()) {
      for (const item of group.queue.splice(0)) {
        detach(item);
        item.reject(error);
      }
    }
    state.queued = 0;
    for (const group of [...groups.all()]) groups.maybeDeleteGroup(group);
  }

  function snapshot() {
    let oldestQueuedAt = Infinity;
    let owners = 0;
    for (const group of groups.all()) {
      if (group.active || group.queue.length) owners += 1;
      for (const item of group.queue) {
        oldestQueuedAt = Math.min(oldestQueuedAt, Number(item.queuedAt) || Infinity);
      }
    }
    return {
      active: state.active,
      queued: state.queued,
      owners,
      activeMax: Number.isFinite(maxActive) ? maxActive : null,
      dispatchBurst: maxBurst,
      queueMax: maxQueued,
      oldestWaitMs: Number.isFinite(oldestQueuedAt) ? Math.max(0, now() - oldestQueuedAt) : 0,
    };
  }

  return {
    enqueue,
    close,
    snapshot,
    get active() {
      return state.active;
    },
    get queued() {
      return state.queued;
    },
  };
}
