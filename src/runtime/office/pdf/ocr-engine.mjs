// One OCR engine per language set and cache, on a thread of its own so that a
// stalled start (the first-use language download) or a cancelled page can be
// ended at once: ending the thread ends the engine and its download. Callers
// arriving while it starts share that start; the engine ends when the last
// caller releases it.
import { Worker } from 'node:worker_threads';
import { workerExecArgv } from '../../shared/worker-exec-argv.mjs';

const ENGINE_URL = new URL('./ocr-engine-worker.mjs', import.meta.url);

/** The start includes the first-use download; without network it fails or hangs. */
export const OCR_ENGINE_START_TIMEOUT_MS = 90_000;

const engines = new Map();

const cancelledError = () => new Error('PDF OCR was cancelled');
const unavailableError = (message) => Object.assign(new Error(message), { code: 'OCR_UNAVAILABLE' });

const defaultSpawn = (url, options) => new Worker(url, options);

/** How many engine threads are running (for diagnostics and tests). */
export function liveOcrEngines() {
  return engines.size;
}

// Ends the engine: its thread, its start and every page it still owes.
function closeEngine(entry, error) {
  if (entry.closed) return;
  entry.closed = true;
  entry.error = error;
  clearTimeout(entry.timer);
  if (engines.get(entry.key) === entry) engines.delete(entry.key);
  entry.failStart(error);
  const jobs = [...entry.jobs.values()];
  entry.jobs.clear();
  for (const job of jobs) job.reject(error);
  void entry.thread.terminate().catch(() => {});
}

function startEngine(key, { languages, cachePath, langPath, timeoutMs, spawn }) {
  const entry = { key, holders: 0, jobs: new Map(), nextJob: 0, closed: false, error: null };
  entry.started = new Promise((resolve, reject) => {
    entry.markStarted = resolve;
    entry.failStart = reject;
  });
  entry.started.catch(() => {});
  entry.thread = spawn(ENGINE_URL, {
    execArgv: workerExecArgv(),
    workerData: { languages, cachePath, langPath: langPath || null },
  });
  entry.timer = setTimeout(
    () => closeEngine(entry, unavailableError('OCR language data did not load in time (it downloads on first use)')),
    timeoutMs
  );
  entry.timer.unref?.();
  entry.thread.on('message', (message) => {
    if (message?.ready) {
      clearTimeout(entry.timer);
      entry.markStarted();
      return;
    }
    if (message?.startError) {
      closeEngine(entry, unavailableError(`OCR could not start: ${message.startError}`));
      return;
    }
    const job = entry.jobs.get(message?.id);
    if (!job) return;
    entry.jobs.delete(message.id);
    if (message.error) job.reject(new Error(`OCR failed: ${message.error}`));
    else job.resolve(message.data);
  });
  entry.thread.on('error', (error) => closeEngine(entry, error));
  entry.thread.on('exit', (code) => closeEngine(entry, new Error(`OCR engine stopped (exit ${code})`)));
  engines.set(key, entry);
  return entry;
}

// `promise`, or a cancellation as soon as `signal` aborts.
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function recognizeOn(entry, image, { output, signal } = {}) {
  if (entry.closed) return Promise.reject(entry.error);
  if (signal?.aborted) return Promise.reject(cancelledError());
  const id = ++entry.nextJob;
  const answer = new Promise((resolve, reject) => {
    entry.jobs.set(id, { resolve, reject });
  });
  entry.thread.postMessage({ id, image, output: output || null });
  if (!signal) return answer;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      entry.jobs.delete(id);
      // A page in recognition cannot be stopped inside the engine: the engine
      // ends with it unless another caller still uses it, which then gets the
      // page's (discarded) answer before its own.
      if (entry.holders <= 1) closeEngine(entry, cancelledError());
      reject(cancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    answer.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The engine for `languages` ("eng+kor") with its data cached at `cachePath`,
 * started on first use. Resolves `{ recognize(image, { output, signal }),
 * release() }` once it is ready; the caller releases it when done. Rejects
 * with code OCR_UNAVAILABLE when it does not start within `timeoutMs`, and
 * with a cancellation when `signal` aborts, ending the start if no one else
 * waits on it.
 */
export async function acquireOcrEngine({
  languages,
  cachePath,
  langPath = null,
  signal = null,
  timeoutMs = OCR_ENGINE_START_TIMEOUT_MS,
  spawn = defaultSpawn,
}) {
  if (signal?.aborted) throw cancelledError();
  const key = `${cachePath}\0${languages}\0${langPath || ''}`;
  const entry = engines.get(key) || startEngine(key, { languages, cachePath, langPath, timeoutMs, spawn });
  entry.holders += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.holders -= 1;
    if (entry.holders <= 0) closeEngine(entry, new Error('OCR engine released'));
  };
  try {
    await untilAborted(entry.started, signal);
  } catch (error) {
    release();
    throw error;
  }
  return { recognize: (image, options) => recognizeOn(entry, image, options), release };
}
