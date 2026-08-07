/**
 * Coalesces external-store publications to one terminal frame snapshot.
 * Internal draft mutations remain synchronous. The public snapshot, listener
 * delivery, and structureRevision commit are swapped atomically at flush.
 */
export function createFrameBatchedStorePublisher({
  getState,
  publishState,
  listeners,
  isDisposed = () => false,
  frameMs = 16,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  enqueueMicrotask = queueMicrotask,
  scheduleFrame = (callback, delay) => setTimer(callback, delay),
  cancelFrame = (handle) => clearTimer(handle),
}) {
  let timer = null;
  let emitPending = false;
  let structureChangePending = false;
  let immediatePending = false;

  const flush = () => {
    if (timer !== null) {
      cancelFrame(timer);
      timer = null;
    }
    immediatePending = false;
    if (!emitPending || isDisposed()) return false;
    emitPending = false;
    const current = getState();
    let next = current;
    if (structureChangePending) {
      structureChangePending = false;
      next = {
        ...current,
        structureRevision: (Number(current.structureRevision) || 0) + 1,
      };
    }
    publishState(next);
    for (const listener of listeners) listener();
    return true;
  };

  const emit = () => {
    emitPending = true;
    if (timer !== null || isDisposed()) return;
    timer = scheduleFrame(flush, frameMs);
    timer?.unref?.();
  };

  const markStructureChange = () => {
    structureChangePending = true;
  };

  // Let the current synchronous mutation chain finish, then publish without
  // waiting for the frame timer (input echo / terminal turn boundaries).
  const flushImmediate = () => {
    if (!emitPending || immediatePending || isDisposed()) return false;
    immediatePending = true;
    enqueueMicrotask(flush);
    return true;
  };

  const dispose = () => {
    // Disposal is itself an immediate boundary: publish the final pending
    // snapshot once, while subscribers are still present, then disarm.
    if (emitPending && !isDisposed()) flush();
    else if (timer !== null) cancelFrame(timer);
    timer = null;
    emitPending = false;
    structureChangePending = false;
    immediatePending = false;
  };

  return { emit, flush, flushImmediate, markStructureChange, dispose };
}
