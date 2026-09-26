// Request/response over one lazily started, shared worker thread. Used to keep
// synchronous native work (process creation, SQLite queries) off the host
// event loop while callers simply await the answer.
import { parentPort, Worker } from 'node:worker_threads';

/**
 * Returns `request(payload) → Promise<result>`. The worker starts on first use,
 * holds the process open only while a request is pending, and is recreated
 * after it dies (its pending requests reject). Worker errors keep `code`.
 *
 * `idleExitMs` (optional): once the worker has had no request pending for
 * that long, it is retired and terminated; the next request starts a fresh
 * one. Retirement only ever happens with nothing pending, and a retired
 * worker is detached before it is terminated, so no request is ever sent to
 * (or lost with) a worker that is shutting down.
 * `request.running()` reports whether a worker thread is currently attached.
 */
export function createWorkerRequestClient(url, { idleExitMs = 0, ...workerOptions } = {}) {
  let worker = null;
  let nextRequestId = 0;
  // Requests belong to the worker they were posted to: a replacement worker
  // must never reject (or answer) another worker's requests.
  let pending = new Map();
  let idleTimer = null;

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdleTimer(target) {
    if (!(idleExitMs > 0)) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (worker !== target || pending.size > 0) return;
      worker = null;
      pending = new Map();
      void target.terminate();
    }, idleExitMs);
    idleTimer.unref?.();
  }

  function ensureWorker() {
    if (worker) return worker;
    const created = new Worker(url, { execArgv: [], ...workerOptions });
    const owned = pending;
    const rejectOwned = (error) => {
      const entries = [...owned.values()];
      owned.clear();
      for (const entry of entries) entry.reject(error);
    };
    created.on('message', ({ id, result, error }) => {
      const entry = owned.get(id);
      if (!entry) return;
      owned.delete(id);
      if (owned.size === 0) {
        // An idle worker never keeps the process alive.
        created.unref();
        if (worker === created) armIdleTimer(created);
      }
      if (error) entry.reject(Object.assign(new Error(error.message), { code: error.code }));
      else entry.resolve(result);
    });
    created.on('error', (error) => {
      if (worker === created) {
        worker = null;
        pending = new Map();
        clearIdleTimer();
      }
      rejectOwned(error);
    });
    created.on('exit', (code) => {
      if (worker === created) {
        worker = null;
        pending = new Map();
        clearIdleTimer();
      }
      rejectOwned(Object.assign(new Error(`worker exited (${code}): ${url}`), { code: 'EWORKEREXIT' }));
    });
    created.unref();
    worker = created;
    return created;
  }

  function request(payload) {
    return new Promise((resolve, reject) => {
      const target = ensureWorker();
      clearIdleTimer();
      const id = ++nextRequestId;
      pending.set(id, { resolve, reject });
      target.ref();
      target.postMessage({ id, payload });
    });
  }
  request.running = () => worker !== null;
  return request;
}

/** Worker side: answer every request with `handler(payload)` (sync or async). */
export function serveWorkerRequests(handler) {
  parentPort.on('message', ({ id, payload }) => {
    Promise.resolve()
      .then(() => handler(payload))
      .then(
        (result) => parentPort.postMessage({ id, result }),
        (error) =>
          parentPort.postMessage({
            id,
            error: { message: String(error?.message || error), code: error?.code ?? null },
          })
      );
  });
}
