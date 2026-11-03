// Off-main-thread comment/string masking. Masking every file that mentions a
// queried name was the largest share of a code_graph query's main-thread time
// (seconds for a common name on a large root), and it is a pure function of
// (text, lang), so it runs in a small worker pool.
//
// Every refusal or failure rejects, and the caller then masks that text on its
// own thread (in yielding slices, _prewarmMaskedSourceNodes):
// - outstanding work is bounded: queued + running texts may not exceed
//   MAX_OUTSTANDING_CHARS (one request is always admitted when nothing is
//   outstanding), so concurrent queries cannot grow the queue without bound;
//   past it a request is refused, or (`waitForAdmission`) waits its turn;
// - an aborted caller's queued request is dropped;
// - each worker runs one request at a time under a deadline; a worker past it
//   is terminated (a replacement spawns for the next request), as is one that
//   crashed;
// - a worker is ref'd only while it runs a request, exits after an idle
//   period, and every worker is terminated on process exit.
import { Worker } from 'node:worker_threads';
import { runInRootAsyncContext } from '../../../../shared/root-async-context.mjs';

const POOL_SIZE = 2;
const IDLE_EXIT_MS = 15_000;
const REQUEST_DEADLINE_MS = 30_000;
const MAX_OUTSTANDING_CHARS = 16 * 1024 * 1024;
const DEFAULT_CONFIG = {
  createWorker: (url, options) => new Worker(url, options),
  deadlineMs: REQUEST_DEADLINE_MS,
  maxOutstandingChars: MAX_OUTSTANDING_CHARS,
};
let _config = DEFAULT_CONFIG;
const _slots = [];
const _queue = [];
// Requests waiting for admission (`waitForAdmission`); they hold no chars.
const _waiting = [];
let _outstandingChars = 0;
let _nextId = 0;

function _maskPoolError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function _spawn() {
  // execArgv: [] — inherited parent flags (e.g. --input-type) can stop a worker from starting.
  // Root context: a shared worker first spawned inside one query must not pin
  // that query's async stores (its hit memo) for the worker's whole life.
  const worker = runInRootAsyncContext(() =>
    _config.createWorker(new URL('./mask-worker.mjs', import.meta.url), {
      execArgv: [],
      stdout: true,
      stderr: true,
    })
  );
  const slot = { worker, request: null, idleTimer: null };
  worker.on('message', ({ id, masked, error }) => {
    const request = slot.request;
    if (!request || request.id !== id) return;
    clearTimeout(request.timer);
    slot.request = null;
    _release(request);
    _settle(request, error ? new Error(error) : null, masked);
    _idle(slot);
    _dispatch();
  });
  worker.on('error', (error) => _retire(slot, error));
  worker.on('exit', () => _retire(slot, _maskPoolError('mask worker exited', 'ERR_MASK_WORKER_EXITED')));
  worker.unref();
  _slots.push(slot);
  return slot;
}

// Drop a worker (crashed, exited, stalled or shut down) and fail its request.
function _retire(slot, error) {
  const index = _slots.indexOf(slot);
  if (index < 0) return;
  _slots.splice(index, 1);
  clearTimeout(slot.idleTimer);
  void slot.worker.terminate();
  const request = slot.request;
  slot.request = null;
  if (request) {
    clearTimeout(request.timer);
    _release(request);
    _settle(request, error);
  }
  _dispatch();
}

function _idle(slot) {
  slot.worker.unref();
  clearTimeout(slot.idleTimer);
  slot.idleTimer = runInRootAsyncContext(() =>
    setTimeout(() => {
      if (!slot.request) _retire(slot, null);
    }, IDLE_EXIT_MS)
  );
  slot.idleTimer.unref?.();
}

function _release(request) {
  if (request.released) return;
  request.released = true;
  _outstandingChars -= request.chars;
}

function _settle(request, error, value) {
  if (request.settled) return;
  request.settled = true;
  request.signal?.removeEventListener('abort', request.onAbort);
  if (error) request.reject(error);
  else request.resolve(value);
}

// Admit waiting requests in arrival order while the outstanding bound allows.
function _admitWaiting() {
  while (_waiting.length) {
    const next = _waiting[0];
    if (_outstandingChars > 0 && _outstandingChars + next.chars > _config.maxOutstandingChars) return;
    _waiting.shift();
    _outstandingChars += next.chars;
    _queue.push(next);
  }
}

function _dispatch() {
  _admitWaiting();
  while (_queue.length) {
    let slot = _slots.find((candidate) => !candidate.request);
    if (!slot && _slots.length < POOL_SIZE) {
      try {
        slot = _spawn();
      } catch (error) {
        // Construction failed: fail the head request (the caller falls back)
        // rather than leave it queued with its chars and abort listener.
        const failed = _queue.shift();
        _release(failed);
        _settle(failed, error);
        // Its released charge may admit a waiter that nothing else would wake.
        _admitWaiting();
        continue;
      }
    }
    if (!slot) return;
    const request = _queue.shift();
    slot.request = request;
    clearTimeout(slot.idleTimer);
    slot.worker.ref();
    request.timer = runInRootAsyncContext(() =>
      setTimeout(
        () => _retire(slot, _maskPoolError(`mask worker exceeded ${_config.deadlineMs}ms`, 'ERR_MASK_WORKER_DEADLINE')),
        _config.deadlineMs
      )
    );
    request.timer.unref?.();
    slot.worker.postMessage({ id: request.id, texts: request.texts, langs: request.langs });
  }
}

/**
 * Mask `texts[i]` as language `langs[i]` in a worker; resolves to the masked
 * strings, or rejects (saturated, aborted, deadline, crash) and the caller
 * masks on its own path. `waitForAdmission` turns a saturated refusal into
 * backpressure: the request waits (holding no outstanding chars, honouring
 * `signal`) until the bound admits it, in arrival order; while any request
 * waits, a non-waiting one is refused rather than overtaking it.
 */
export function _maskTextsOffThread(texts, langs, { signal = null, waitForAdmission = false } = {}) {
  if (signal?.aborted) return Promise.reject(_maskPoolError('aborted', 'ABORT_ERR'));
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  const admissible =
    _waiting.length === 0 && (_outstandingChars === 0 || _outstandingChars + chars <= _config.maxOutstandingChars);
  if (!admissible && !waitForAdmission) {
    return Promise.reject(_maskPoolError('mask pool saturated', 'ERR_MASK_POOL_SATURATED'));
  }
  return new Promise((resolve, reject) => {
    const request = { id: ++_nextId, texts, langs, chars, signal, resolve, reject, timer: null };
    request.onAbort = () => {
      const waiting = _waiting.indexOf(request);
      if (waiting >= 0) _waiting.splice(waiting, 1);
      const queued = _queue.indexOf(request);
      if (queued >= 0) {
        _queue.splice(queued, 1);
        _release(request);
      }
      // A running request keeps its worker (and its chars) until the worker
      // answers; only the caller stops waiting.
      _settle(request, _maskPoolError('aborted', 'ABORT_ERR'));
      _dispatch();
    };
    signal?.addEventListener('abort', request.onAbort, { once: true });
    _waiting.push(request);
    _dispatch();
  });
}

/** Reject everything outstanding and terminate every worker. */
export function _shutdownMaskPool() {
  const error = _maskPoolError('mask pool shut down', 'ERR_MASK_POOL_SHUTDOWN');
  for (const request of _waiting.splice(0)) _settle(request, error);
  for (const request of _queue.splice(0)) {
    _release(request);
    _settle(request, error);
  }
  for (const slot of [..._slots]) _retire(slot, error);
}

/** Test seam: override `{ createWorker, deadlineMs, maxOutstandingChars }`; no argument restores the defaults. */
export function _configureMaskPoolForTest(overrides = null) {
  _shutdownMaskPool();
  _config = overrides ? { ...DEFAULT_CONFIG, ...overrides } : DEFAULT_CONFIG;
}

/** Chars queued or running — the quantity the outstanding-work bound applies to. */
export function _maskPoolOutstandingChars() {
  return _outstandingChars;
}

process.once('exit', _shutdownMaskPool);
