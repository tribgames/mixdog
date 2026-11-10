/**
 * worker-slots/pending-queue.mjs — the pending-byte backpressure queue: work
 * posts while the in-flight budget allows it, waits behind the backlog cap
 * otherwise, and is rejected as resource pressure when it fits neither.
 */
export function createPendingQueue({ state, postTask }) {
  const hasHeadroom = (bytes) => state.pendingBytes === 0 || state.pendingBytes + bytes <= state.pendingByteMax;

  function removeWaiting(task) {
    const index = state.waiting.indexOf(task);
    if (index < 0) return false;
    state.waiting.splice(index, 1);
    state.waitingBytes = Math.max(0, state.waitingBytes - task.bytes);
    return true;
  }

  function drainWaiting() {
    while (state.waiting.length > 0) {
      const task = state.waiting[0];
      if (state.pendingBytes > 0 && state.pendingBytes + task.bytes > state.pendingByteMax) return;
      state.waiting.shift();
      state.waitingBytes = Math.max(0, state.waitingBytes - task.bytes);
      if (task.aborted) continue;
      postTask(task);
    }
  }

  function enqueue(task) {
    if (hasHeadroom(task.bytes)) {
      postTask(task);
      return;
    }
    if (state.waitingBytes + task.bytes > state.pendingByteMax) {
      task.detach();
      const error = new Error(`provider stream JSON backlog exceeded ${state.pendingByteMax} bytes`);
      error.code = 'ERESOURCEPRESSURE';
      task.reject(error);
      return;
    }
    state.waiting.push(task);
    state.waitingBytes += task.bytes;
  }

  /** Reject every queued task (pool close). */
  function rejectAll(error) {
    for (const task of state.waiting.splice(0)) {
      task.detach();
      if (!task.aborted) task.reject(error);
    }
    state.waitingBytes = 0;
  }

  return { hasHeadroom, removeWaiting, drainWaiting, enqueue, rejectAll };
}
