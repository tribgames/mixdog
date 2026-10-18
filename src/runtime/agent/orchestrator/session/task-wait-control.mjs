// Per-session wake control for `task wait` and the foreground shell hold.
//
// This is intentionally separate from the turn AbortController: new user input
// or a queued task notification releases only the passive wait, lets the tool
// return a running snapshot, and then flows through the normal post-tool
// steering boundary. The background task itself keeps running.
const waitersBySession = new Map();
const steeringChecks = new Set();

// Why a wait was released early: user input/steering, or a deliverable task
// notification queued for the session.
export const TASK_WAIT_WAKE_USER = 'user-message';
export const TASK_WAIT_WAKE_NOTIFICATION = 'notification';

// Scoped to an active turn. Read the live queue at wait entry rather than
// retaining a wake signal that could outlive a consumed or reclaimed prompt.
// A check returns a wake reason (or true for user input) when something
// deliverable is already queued for the session, else a falsy value.
export function registerTaskWaitSteeringCheck(check) {
  steeringChecks.add(check);
  return () => steeringChecks.delete(check);
}

function sessionKey(sessionId) {
  return String(sessionId || '').trim();
}

export function beginInterruptibleTaskWait(sessionId, parentSignal = null) {
  const key = sessionKey(sessionId);
  if (!key) {
    return {
      signal: parentSignal || null,
      interruptedByUser: false,
      dispose() {},
    };
  }

  const controller = new AbortController();
  const waiter = {
    controller,
    interruptedByUser: false,
    wakeReason: null,
    wakeDetail: null,
  };
  let waiters = waitersBySession.get(key);
  if (!waiters) {
    waiters = new Set();
    waitersBySession.set(key, waiters);
  }
  waiters.add(waiter);

  let disposed = false;
  const onParentAbort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else {
      try {
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
      } catch {}
    }
  }

  if (!controller.signal.aborted) {
    let queued = null;
    for (const check of steeringChecks) {
      const found = check(key);
      if (!found) continue;
      const reason = found === true ? TASK_WAIT_WAKE_USER : String(found);
      // User input outranks a notification: its result text asks the model
      // to handle the new message first.
      if (!queued || reason === TASK_WAIT_WAKE_USER) queued = reason;
      if (queued === TASK_WAIT_WAKE_USER) break;
    }
    if (queued) wakeWaiter(waiter, queued, null);
  }

  return {
    signal: controller.signal,
    get interruptedByUser() {
      return waiter.interruptedByUser;
    },
    get wakeReason() {
      return waiter.wakeReason;
    },
    get wakeDetail() {
      return waiter.wakeDetail;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (parentSignal) {
        try {
          parentSignal.removeEventListener('abort', onParentAbort);
        } catch {}
      }
      waiters.delete(waiter);
      if (waiters.size === 0) waitersBySession.delete(key);
    },
  };
}

function wakeWaiter(waiter, reason, detail) {
  waiter.interruptedByUser = reason !== TASK_WAIT_WAKE_NOTIFICATION;
  waiter.wakeReason = reason;
  waiter.wakeDetail = detail || null;
  try {
    waiter.controller.abort(reason);
  } catch {}
}

// `detail` names what woke the wait (the notified task id) for its result text.
export function interruptTaskWaitForSession(sessionId, reason = TASK_WAIT_WAKE_USER, detail = null) {
  const waiters = waitersBySession.get(sessionKey(sessionId));
  if (!waiters?.size) return 0;
  let interrupted = 0;
  for (const waiter of [...waiters]) {
    if (waiter.controller.signal.aborted) continue;
    interrupted += 1;
    wakeWaiter(waiter, reason, detail);
  }
  return interrupted;
}

export function activeTaskWaitCountForSession(sessionId) {
  return waitersBySession.get(sessionKey(sessionId))?.size || 0;
}
