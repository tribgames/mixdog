/**
 * stream-json-pool/worker-slots.mjs — the worker threads themselves: task
 * posting, message settlement, slot loss, and shutdown. The pool state is one
 * explicit record shared with worker-slots/: slot-spawn (construction latch,
 * wiring, ref discipline), slot-pick (owner-affine selection) and
 * pending-queue (pending-byte backpressure).
 */
import { Worker } from 'node:worker_threads';
import { createSlotSpawner } from './worker-slots/slot-spawn.mjs';
import { pickSlot } from './worker-slots/slot-pick.mjs';
import { createPendingQueue } from './worker-slots/pending-queue.mjs';

function syntaxError(details) {
  const error = new SyntaxError(String(details?.message || 'invalid JSON'));
  error.name = String(details?.name || 'SyntaxError');
  return error;
}

export function createWorkerSlots({ workerMax, pendingByteMax, WorkerImpl = Worker, stats, affinities, isClosed }) {
  const state = {
    workerMax,
    pendingByteMax,
    stats,
    slots: [],
    waiting: [],
    pendingBytes: 0,
    waitingBytes: 0,
    spawnFailures: 0,
  };

  /**
   * Re-run a task's work on the owner thread. Every task kind carries an
   * `inline()` that is the exact equivalent of the worker computation, so a
   * dead worker, a failed postMessage or a closing pool degrades to local
   * CPU instead of failing a live stream.
   */
  function settleInline(task) {
    stats.fallbackBatches += 1;
    try {
      task.resolve(task.inline());
    } catch (error) {
      task.reject(error);
    }
  }

  /** The task no longer occupies the in-flight budget or its stream slot. */
  function releaseTask(task) {
    state.pendingBytes = Math.max(0, state.pendingBytes - task.bytes);
    task.detach();
  }

  const spawner = createSlotSpawner({
    state,
    WorkerImpl,
    isClosed,
    affinities,
    onMessage: handleMessage,
    onLost: failSlot,
  });
  const queue = createPendingQueue({ state, postTask });

  function failSlot(slot) {
    if (slot.failed) return;
    slot.failed = true;
    spawner.removeSlot(slot);
    for (const task of slot.tasks.values()) {
      releaseTask(task);
      if (task.aborted) continue;
      settleInline(task);
    }
    slot.tasks.clear();
    try {
      slot.worker.terminate();
    } catch {}
    queue.drainWaiting();
  }

  function handleMessage(slot, message) {
    const task = slot.tasks.get(Number(message?.id));
    if (!task) return;
    slot.tasks.delete(Number(message.id));
    spawner.syncSlotRef(slot);
    releaseTask(task);
    if (task.aborted) return;
    if (message?.ok === true) task.resolve(task.decode(message));
    else if (task.kind === 'sse') settleInline(task);
    else task.reject(syntaxError(message?.error));
    queue.drainWaiting();
  }

  function postTask(task) {
    let slot = null;
    try {
      slot = pickSlot({ state, affinities, spawner }, task.owner);
    } catch {
      // A WorkerImpl whose constructor (or wiring) throws must not fail
      // the caller: treat it as "no worker available".
      spawner.noteSpawnFailure();
      slot = null;
    }
    if (!slot) {
      // Deterministic inline fallback: same computation, same result,
      // no rejection, and abort/retry semantics are untouched.
      task.detach();
      if (!task.aborted) settleInline(task);
      return;
    }
    task.slot = slot;
    slot.tasks.set(task.id, task);
    state.pendingBytes += task.bytes;
    spawner.syncSlotRef(slot);
    try {
      slot.worker.postMessage(task.message);
    } catch {
      slot.tasks.delete(task.id);
      spawner.syncSlotRef(slot);
      releaseTask(task);
      if (!task.aborted) settleInline(task);
      queue.drainWaiting();
    }
  }

  // Reject queued work, finish in-flight SSE chunks inline (a live provider
  // stream must not fail because the pool is shutting down), reject in-flight
  // batches, and return the worker termination promises.
  function close(error) {
    queue.rejectAll(error);
    const workers = [];
    for (const slot of state.slots.splice(0)) {
      for (const task of slot.tasks.values()) {
        task.detach();
        if (task.aborted) continue;
        if (task.kind === 'sse') settleInline(task);
        else task.reject(error);
      }
      slot.tasks.clear();
      workers.push(Promise.resolve(slot.worker.terminate()).catch(() => {}));
    }
    return workers;
  }

  function snapshot() {
    return {
      workers: state.slots.filter((slot) => !slot.failed).length,
      workerMax,
      activeBatches: state.slots.reduce((sum, slot) => sum + slot.tasks.size, 0),
      pendingBytes: state.pendingBytes,
      waitingBatches: state.waiting.length,
      waitingBytes: state.waitingBytes,
      maxPendingBytes: pendingByteMax,
      spawnFailures: stats.spawnFailures,
      workerSpawnDisabled: !spawner.spawnAllowed(),
    };
  }

  return {
    settleInline,
    postTask,
    enqueue: queue.enqueue,
    removeWaiting: queue.removeWaiting,
    hasHeadroom: queue.hasHeadroom,
    close,
    snapshot,
  };
}
