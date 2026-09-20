/**
 * worker-slots/slot-spawn.mjs — spawning a worker slot: the construction
 * failure latch, listener wiring, and the ref/unref discipline that keeps an
 * idle worker from holding the process open.
 */
import { Worker } from 'node:worker_threads';

// After this many consecutive worker-construction failures the pool stops
// trying to spawn and stays inline. This is a failure latch, not a throttle:
// it never limits concurrent streams, it only stops re-throwing constructors.
const MAX_SPAWN_FAILURES = 3;

export function createSlotSpawner({ state, WorkerImpl = Worker, isClosed, affinities, onMessage, onLost }) {
  function noteSpawnFailure() {
    state.spawnFailures += 1;
    state.stats.spawnFailures += 1;
  }

  function spawnAllowed() {
    return !isClosed() && state.workerMax > 0 && state.spawnFailures < MAX_SPAWN_FAILURES;
  }

  /**
   * A worker keeps the event loop alive only while it owes an answer: idle
   * workers stay unref'd (no process is held open by the pool), busy workers
   * are ref'd (an in-flight chunk can never be lost to an early exit).
   */
  function syncSlotRef(slot) {
    try {
      if (slot.tasks.size > 0) slot.worker.ref?.();
      else slot.worker.unref?.();
    } catch {
      /* ref/unref is best-effort */
    }
  }

  function removeSlot(slot) {
    const index = state.slots.indexOf(slot);
    if (index >= 0) state.slots.splice(index, 1);
    affinities.forgetSlot(slot);
  }

  function wireSlot(slot) {
    const worker = slot.worker;
    worker.on('message', (message) => onMessage(slot, message));
    worker.on('error', () => onLost(slot));
    worker.on('exit', () => {
      if (!isClosed()) onLost(slot);
      else removeSlot(slot);
    });
    // Attaching the message listener starts (and refs) the public port, so
    // the pre-listener unref() above is not enough: an idle worker must not
    // hold a short-lived process open until the pool is closed.
    syncSlotRef(slot);
  }

  /**
   * Spawn a worker slot.
   *
   * Construction and listener wiring can throw (missing worker file, thread
   * limit, restricted runtime). That must never reach a live stream, so a
   * failure is latched and reported as `null` — "no worker available" — and
   * the caller runs the same work inline instead.
   */
  function createSlot() {
    let worker;
    try {
      worker = new WorkerImpl(new URL('../../stream-json-worker.mjs', import.meta.url), {
        execArgv: [],
      });
    } catch {
      noteSpawnFailure();
      return null;
    }
    const slot = { worker, tasks: new Map(), failed: false };
    try {
      worker.unref?.();
      wireSlot(slot);
    } catch {
      noteSpawnFailure();
      try {
        worker.terminate?.();
      } catch {}
      return null;
    }
    state.spawnFailures = 0;
    state.slots.push(slot);
    return slot;
  }

  return { noteSpawnFailure, spawnAllowed, syncSlotRef, removeSlot, createSlot };
}
