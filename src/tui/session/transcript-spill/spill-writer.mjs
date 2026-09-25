// transcript-spill/spill-writer.mjs
// Writes spilled pages to disk through a worker thread so serialization and
// filesystem I/O stay off the render thread. One write in flight at a time,
// each attempt to a distinct temp file with atomic rename as the sole commit
// point (a timed-out old worker can therefore expose only a complete page,
// never a partial target file). A page that fails twice is PINNED: it keeps
// its items in memory and the writer reports it so the owner stops spilling.
// A worker thread costs ~10 MB RSS, so it is retired once every write has
// settled and nothing arrived for idleMs; the next enqueue spawns a fresh one.
// Pages are self-contained files named by the owner, so a restart continues
// the same spill directory with nothing to hand over.
import { randomUUID } from 'node:crypto';

const MAX_ATTEMPTS = 2;
export const SPILL_WRITER_IDLE_MS = 10_000;

const WORKER_SOURCE = `
    const { parentPort } = require('node:worker_threads');
    const { renameSync, writeFileSync } = require('node:fs');
    parentPort.on('message', ({ id, targetPath, tempPath, items }) => {
      try {
        writeFileSync(tempPath, JSON.stringify(items), 'utf8');
        renameSync(tempPath, targetPath);
        parentPort.postMessage({ id, ok: true });
      } catch (error) {
        parentPort.postMessage({ id, ok: false, error: String(error && error.message || error) });
      }
    });`;

export function createSpillWriter({ workerFactory, writeTimeoutMs = 5000, idleMs = SPILL_WRITER_IDLE_MS, onPinned }) {
  const queue = [];
  let worker = null;
  let spawnCount = 0;
  let active = null;
  let activeTimer = null;
  let idleTimer = null;

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  /** Detach first so the worker's own exit event is ignored, then end it. */
  function retireWorker() {
    const current = worker;
    worker = null;
    try {
      current?.terminate?.();
    } catch {}
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (!worker) return;
    idleTimer = setTimeout(
      () => {
        idleTimer = null;
        if (active || queue.length) return;
        retireWorker();
      },
      Math.max(1, Number(idleMs) || SPILL_WRITER_IDLE_MS)
    );
    idleTimer.unref?.();
  }

  function retryOrPin(record, error) {
    if (record.cancelled) return;
    record.attempts += 1;
    if (record.attempts <= MAX_ATTEMPTS) {
      queue.unshift(record);
      return;
    }
    record.pinned = true;
    for (const queued of queue.splice(0)) {
      if (!queued.cancelled) queued.pinned = true;
    }
    onPinned(error);
  }

  /** The worker is gone (error, exit, timeout): its in-flight write is retried
   *  or pinned and the queue continues on a fresh worker. */
  function abandonWorker(current, reason) {
    if (worker !== current) return;
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = null;
    const failed = active;
    active = null;
    worker = null;
    try {
      current.terminate?.();
    } catch {}
    if (failed) retryOrPin(failed, reason);
    pump();
  }

  function ensureWorker() {
    if (worker) return worker;
    try {
      const spawned = workerFactory(WORKER_SOURCE);
      worker = spawned;
      spawnCount += 1;
      // Worker output is forwarded to our stderr rather than the real fds so
      // the TUI stderr guard still applies.
      const forward = (chunk) => {
        try {
          process.stderr.write(chunk);
        } catch {
          /* best-effort */
        }
      };
      spawned.stdout?.on?.('data', forward);
      spawned.stderr?.on?.('data', forward);
      spawned.on('message', (result) => {
        if (worker !== spawned || result?.id !== active?.id) return;
        finishWrite(result?.ok === true, result?.error);
      });
      spawned.on('error', (error) => abandonWorker(spawned, error?.message));
      spawned.on('exit', (code) => abandonWorker(spawned, `spill worker exited (${code})`));
      spawned.unref?.();
    } catch (error) {
      worker = null;
      if (active) {
        const failed = active;
        active = null;
        retryOrPin(failed, error?.message);
      }
    }
    return worker;
  }

  function finishWrite(ok, error) {
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = null;
    const record = active;
    active = null;
    if (record && !record.cancelled) {
      if (ok) record.pendingItems = null;
      else retryOrPin(record, error);
    }
    pump();
  }

  function pump() {
    if (active) return;
    while (queue.length && queue[0].cancelled) queue.shift();
    if (!queue.length) {
      armIdleTimer();
      return;
    }
    clearIdleTimer();
    active = queue.shift();
    const current = ensureWorker();
    if (!current) {
      if (active) {
        const failed = active;
        active = null;
        retryOrPin(failed, 'worker unavailable');
      }
      queueMicrotask(pump);
      return;
    }
    // Pages are capped at chunkSize, so the structured-clone post cost is
    // bounded; the retry payload is identical to the first attempt.
    const tempPath = `${active.path}.attempt-${active.attempts}-${randomUUID()}.tmp`;
    current.postMessage({ id: active.id, targetPath: active.path, tempPath, items: active.pendingItems });
    activeTimer = setTimeout(
      () => {
        if (!active) return;
        abandonWorker(current, `write timed out after ${writeTimeoutMs}ms`);
      },
      Math.max(1, Number(writeTimeoutMs) || 5000)
    );
    activeTimer.unref?.();
  }

  return {
    enqueue(record) {
      queue.push(record);
      pump();
    },
    get workerCount() {
      return spawnCount;
    },
    get pendingCount() {
      return queue.length + (active ? 1 : 0);
    },
    get workerAlive() {
      return worker !== null;
    },
    dispose() {
      queue.length = 0;
      active = null;
      if (activeTimer) clearTimeout(activeTimer);
      activeTimer = null;
      clearIdleTimer();
      retireWorker();
    },
  };
}
