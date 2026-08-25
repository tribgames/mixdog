// Per-session wake control for `task wait`.
//
// This is intentionally separate from the turn AbortController: new user input
// should release only the passive wait, let the tool return a running snapshot,
// and then flow through the normal post-tool steering boundary. The background
// task itself keeps running.
const waitersBySession = new Map();

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
      try { parentSignal.addEventListener('abort', onParentAbort, { once: true }); } catch {}
    }
  }

  return {
    signal: controller.signal,
    get interruptedByUser() {
      return waiter.interruptedByUser;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (parentSignal) {
        try { parentSignal.removeEventListener('abort', onParentAbort); } catch {}
      }
      waiters.delete(waiter);
      if (waiters.size === 0) waitersBySession.delete(key);
    },
  };
}

export function interruptTaskWaitForSession(sessionId, reason = 'user-message') {
  const waiters = waitersBySession.get(sessionKey(sessionId));
  if (!waiters?.size) return 0;
  let interrupted = 0;
  for (const waiter of [...waiters]) {
    if (waiter.controller.signal.aborted) continue;
    waiter.interruptedByUser = true;
    interrupted += 1;
    try { waiter.controller.abort(reason); } catch {}
  }
  return interrupted;
}

export function activeTaskWaitCountForSession(sessionId) {
  return waitersBySession.get(sessionKey(sessionId))?.size || 0;
}
