// Request/response over one lazily started, shared worker thread. Used to keep
// synchronous native work (process creation, SQLite queries) off the host
// event loop while callers simply await the answer.
import { parentPort, Worker } from 'node:worker_threads';
import { runInRootAsyncContext } from './root-async-context.mjs';

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
 *
 * `request(payload, { timeoutMs })`: a request still unanswered after
 * `timeoutMs` rejects with code `ETIMEDOUT` and its worker is terminated.
 * `unref`: that request does not keep the process alive while pending (for
 * best-effort work that may be dropped at exit). `request.hold()` returns a
 * release function; while any hold is open the worker stays referenced, so a
 * caller that waits on an unref'd request still keeps the process alive.
 *
 * `label` (optional): names the worker in error messages; defaults to `url`.
 * Give it when `url` is inline source (`eval: true`).
 *
 * `onEvent` (optional): receives what the worker sends with postWorkerEvent
 * (messages that answer no request).
 */
export function createWorkerRequestClient(
  url,
  { idleExitMs = 0, onEvent = null, label = String(url), ...workerOptions } = {}
) {
  let worker = null;
  let nextRequestId = 0;
  // Requests belong to the worker they were posted to: a replacement worker
  // must never reject (or answer) another worker's requests.
  let pending = new Map();
  let idleTimer = null;
  // Callers waiting on the worker's answer (see request.hold).
  let holds = 0;

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

  // The one rule for whether the attached worker keeps the process alive: only
  // while a caller holds it or a pending request did not ask to be unref'd.
  // Every path that changes either calls this.
  function settleRef(target) {
    if (worker !== target) return;
    if (holds > 0 || [...pending.values()].some((entry) => !entry.unref)) target.ref();
    else target.unref();
  }

  function ensureWorker() {
    if (worker) return worker;
    // Shared by every later caller: never let it retain the first caller's context.
    const created = runInRootAsyncContext(() => new Worker(url, { execArgv: [], ...workerOptions }));
    const owned = pending;
    const rejectOwned = (error) => {
      const entries = [...owned.values()];
      owned.clear();
      for (const entry of entries) entry.reject(error);
    };
    created.on('message', (message) => {
      if (message && Object.hasOwn(message, 'event')) {
        onEvent?.(message.event);
        return;
      }
      const { id, result, error } = message;
      const entry = owned.get(id);
      if (!entry) return;
      owned.delete(id);
      settleRef(created);
      if (owned.size === 0 && worker === created) armIdleTimer(created);
      if (error) {
        entry.reject(
          Object.assign(
            new Error(error.message),
            { code: error.code },
            typeof error.childExited === 'boolean' ? { childExited: error.childExited, pid: error.pid } : {},
            error.timing ? { timing: error.timing } : {}
          )
        );
      } else entry.resolve(result);
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
      rejectOwned(Object.assign(new Error(`worker exited (${code}): ${label}`), { code: 'EWORKEREXIT' }));
    });
    worker = created;
    settleRef(created);
    return created;
  }

  function request(payload, { timeoutMs = 0, unref = false } = {}) {
    return new Promise((resolve, reject) => {
      const target = ensureWorker();
      clearIdleTimer();
      const id = ++nextRequestId;
      const owned = pending;
      let deadline = null;
      owned.set(id, {
        unref,
        resolve: (value) => {
          clearTimeout(deadline);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(deadline);
          reject(error);
        },
      });
      if (timeoutMs > 0) {
        // An unanswered request means the worker is wedged: reject it, detach
        // the worker so the next request starts a fresh one, and terminate it.
        // Its other pending requests are rejected by the exit handler.
        deadline = setTimeout(() => {
          owned.delete(id);
          if (worker === target) {
            worker = null;
            pending = new Map();
            clearIdleTimer();
          }
          reject(
            Object.assign(new Error(`worker request timed out after ${timeoutMs} ms: ${label}`), { code: 'ETIMEDOUT' })
          );
          void target.terminate();
        }, timeoutMs);
        deadline.unref();
      }
      settleRef(target);
      try {
        target.postMessage({ id, payload });
      } catch (error) {
        // Never posted (e.g. an uncloneable payload): drop the entry and
        // restore the state a settled last request would leave.
        owned.delete(id);
        clearTimeout(deadline);
        settleRef(target);
        if (owned.size === 0 && worker === target) armIdleTimer(target);
        throw error;
      }
    });
  }
  // A caller waiting on the worker's answer keeps the process alive for as long
  // as it waits, even for requests posted with `unref`. Returns the release;
  // the last release returns the worker to what its pending requests ask for.
  request.hold = () => {
    holds += 1;
    if (worker) settleRef(worker);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
      if (worker) settleRef(worker);
    };
  };
  request.running = () => worker !== null;
  return request;
}

/**
 * {@link createWorkerRequestClient} over up to `size` workers, for work that
 * blocks its worker's thread (a synchronous process creation): requests go to
 * the worker with the fewest unanswered ones, so they overlap instead of
 * queueing behind each other. A worker starts only when every earlier one is
 * busy. Same `request`, `request.hold` and `request.running` surface.
 *
 * The first worker stays attached once started, as a lone worker would. Every
 * other one retires after `idleExitMs` without a request (see
 * createWorkerRequestClient), so a burst's extra threads do not outlive it.
 * `request.workers()` counts the workers currently attached.
 */
export function createWorkerRequestPool(url, { size, idleExitMs = 0, ...options }) {
  const members = Array.from({ length: size }, (_, index) => ({
    request: createWorkerRequestClient(url, index === 0 ? options : { ...options, idleExitMs }),
    unanswered: 0,
  }));
  function request(payload, requestOptions) {
    const member = members.reduce((best, next) => (next.unanswered < best.unanswered ? next : best));
    member.unanswered += 1;
    return member.request(payload, requestOptions).finally(() => {
      member.unanswered -= 1;
    });
  }
  request.hold = () => {
    const releases = members.map((member) => member.request.hold());
    return () => releases.forEach((release) => release());
  };
  request.workers = () => members.filter((member) => member.request.running()).length;
  request.running = () => request.workers() > 0;
  return request;
}

/** Worker side: send `event` to the client's `onEvent`, outside any request. */
export function postWorkerEvent(event) {
  parentPort.postMessage({ event });
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
            error: {
              message: String(error?.message || error),
              code: error?.code ?? null,
              // A timed-out child's fate (run-child.mjs waitForExitMs).
              ...(typeof error?.childExited === 'boolean'
                ? { childExited: error.childExited, pid: error.pid ?? null }
                : {}),
              // A failed child's account of its time (run-child.mjs runChildTimed).
              ...(error?.timing ? { timing: error.timing } : {}),
            },
          })
      );
  });
}
