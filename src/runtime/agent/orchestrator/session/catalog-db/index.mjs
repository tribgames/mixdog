/**
 * Session catalog DB, phase 2: in the daemon, SQLite is the read source of
 * the ordinary session catalog.
 *
 * Everything runs on one worker thread (./worker.mjs): the catalog engine's
 * change detection (summary index, sessions directory, per-file stamps, `.hb`
 * liveness, background verification) feeds `<dataDir>/session-catalog.sqlite`
 * and an ordinary listing is one request that answers from it. This thread
 * does no filesystem work for it and never loads node:sqlite.
 *
 * JSON stays what every other process reads and writes: the store keeps
 * writing the summary index exactly as before. When one of the daemon's own
 * writes has changed a session file on disk, the store hints the id here
 * (hintSessionCatalogStorage); the worker re-checks it from storage on the
 * next listing. Hints carry no row data. Whenever the DB cannot answer — not
 * the daemon, not Electron, SQLite gate, another process holds the DB,
 * off-switch, backfill or rebuild in progress, any error — `list()` resolves
 * null and the caller uses the JSON path unchanged.
 */
import { isMainThread } from 'node:worker_threads';
import { createWorkerRequestClient } from '../../../../shared/worker-requests.mjs';
import { dataDir as currentDataDir } from '../store-summary-locations.mjs';

export const SESSION_CATALOG_DB_FILE = 'session-catalog.sqlite';
/** Config: `{ "sessionStore": { "sqliteCatalog": false } }` forces the JSON
 *  path (an off-switch); absent or true uses the DB whenever it can. */
export const SESSION_STORE_CONFIG_SECTION = 'sessionStore';
export const SESSION_STORE_CONFIG_DEFAULTS = Object.freeze({ sqliteCatalog: true });
/** Stable prefix of every daemon.log line of the catalog DB. */
export const SESSION_CATALOG_LOG_PREFIX = '[session-catalog-db]';

// A worker that keeps dying is given up on for a while.
const CRASH_WINDOW_MS = 10 * 60_000;
const MAX_CRASHES = 3;
const ERROR_LOG_INTERVAL_MS = 60_000;

let testOptions = null;
let requestWorker = null;
let controller = null;
const changeListeners = new Set();
const noop = () => {};

function log(line) {
  const text = `${SESSION_CATALOG_LOG_PREFIX} ${line}`;
  if (typeof testOptions?.log === 'function') {
    testOptions.log(text);
    return;
  }
  // The daemon's stderr is daemon.log (mirrored by the spawner before ready,
  // redirected into the file after).
  try {
    process.stderr.write(`${text}\n`);
  } catch {
    /* logging is best effort */
  }
}

function onWorkerEvent(event) {
  if (event?.type === 'log') log(event.line);
  else if (event?.type === 'changed') {
    for (const listener of changeListeners) {
      try {
        listener();
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
}

function request(payload) {
  requestWorker ||= createWorkerRequestClient(new URL('./worker.mjs', import.meta.url), {
    // The worker is the only node:sqlite user; its experimental warning is noise.
    execArgv: ['--disable-warning=ExperimentalWarning'],
    onEvent: onWorkerEvent,
  });
  return requestWorker(payload);
}

/** Worker settings a test configured (functions stay on this thread). */
function workerSettings() {
  if (!testOptions) return undefined;
  const settings = {};
  for (const [key, value] of Object.entries(testOptions)) {
    if (typeof value !== 'function' && key !== 'writer') settings[key] = value;
  }
  return settings;
}

/**
 * True only in the daemon process itself, under the packaged or dev Electron
 * runtime: daemon.mjs sets MIXDOG_DAEMON_HOST and MIXDOG_SERVER_PID (its own
 * pid) at startup; children inherit the environment but have another pid,
 * worker threads are not the main thread, and a daemon started by the CLI
 * under system Node stays on JSON.
 */
export function isSessionCatalogDbWriter() {
  if (testOptions && 'writer' in testOptions) return testOptions.writer === true;
  return (
    isMainThread &&
    Boolean(process.versions.electron) &&
    process.env.MIXDOG_DAEMON_HOST === '1' &&
    process.env.MIXDOG_SERVER_PID === String(process.pid)
  );
}

/** The catalog DB of `dataDir`, or null when this process does not keep one. */
export function sessionCatalogDb(dataDir) {
  if (!isSessionCatalogDbWriter()) return null;
  if (controller?.dataDir === dataDir) return controller;
  void controller?.close();
  controller = new SessionCatalogDb(dataDir);
  return controller;
}

/** The existing catalog DB of `dataDir` (never creates one). */
export function currentSessionCatalogDb(dataDir) {
  return controller?.dataDir === dataDir ? controller : null;
}

/** `listener()` runs when the worker's background pass finds a changed
 *  session file (an ordinary listing would now differ). */
export function onSessionCatalogDbChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/**
 * Storage hint from the store (store/summary-cache.mjs): a write of this
 * process changed the files of `ids` — a save landed, a delete removed the
 * file. Tagged with the current data dir; the worker re-checks those ids from
 * storage on the next listing. A lost hint only delays the change to the
 * engine's own detection.
 */
export function hintSessionCatalogStorage(ids) {
  currentSessionCatalogDb(currentDataDir())?.hint(ids);
}

/** Closes the catalog DB (releasing its file, WAL and lock) — the teardown
 *  boundary before a data dir is removed or switched. */
export async function closeSessionCatalogDb() {
  const current = controller;
  controller = null;
  if (current) await current.close();
}

class SessionCatalogDb {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.state = 'active'; // active | off (final: gate) | failed (until failedUntil) | closed
    this.failedUntil = 0;
    this.hints = new Set();
    this.flushHandle = null;
    this.started = false;
    this.crashes = [];
    this.errorLoggedAt = 0;
  }

  send(op, payload = {}) {
    // No running worker: this request starts one. After the first start it
    // is a respawn (the last one died): it reopens and backfills by itself.
    if (!requestWorker?.running()) {
      if (this.started) this.noteRespawn();
      this.started = true;
    }
    return request({ op, dataDir: this.dataDir, settings: workerSettings(), ...payload }).catch((error) => {
      this.noteError(error);
      throw error;
    });
  }

  /** A worker died; more than MAX_CRASHES deaths in the window give up. */
  noteRespawn() {
    const now = Date.now();
    this.crashes = this.crashes.filter((at) => now - at < CRASH_WINDOW_MS);
    this.crashes.push(now);
    if (this.crashes.length > MAX_CRASHES && this.state === 'active') {
      this.state = 'failed';
      this.failedUntil = now + CRASH_WINDOW_MS;
      log(`worker failed ${this.crashes.length} times in 10 min; catalog stays JSON`);
    }
  }

  noteError(error) {
    const now = Date.now();
    if (now - this.errorLoggedAt >= ERROR_LOG_INTERVAL_MS) {
      this.errorLoggedAt = now;
      log(`request failed: ${error?.message || error}; listing answered from JSON`);
    }
  }

  usable() {
    if (this.state === 'failed' && Date.now() >= this.failedUntil) {
      this.state = 'active';
      this.crashes = [];
    }
    return this.state === 'active';
  }

  hint(ids) {
    if (this.state !== 'active') return;
    for (const id of ids) if (id) this.hints.add(String(id));
    if (this.hints.size === 0) return;
    this.flushHandle ||= setImmediate(() => {
      this.flushHandle = null;
      this.flushHints();
    });
  }

  /** Posts the collected hints ahead of any later request. A worker that is
   *  not running gets none: a (re)started worker rescans storage anyway. */
  flushHints() {
    if (this.hints.size === 0) return;
    const ids = [...this.hints];
    this.hints.clear();
    if (!requestWorker?.running()) return;
    this.send('hint', { ids }).catch(noop);
  }

  /**
   * One ordinary listing (`page` = `{ limit, after }` or null for all):
   * `{ rows, more }`, or null when the DB cannot answer (use JSON). Hints
   * collected before this call are posted first.
   */
  async list(page = null, { ownershipLinks = false } = {}) {
    if (!this.usable()) return null;
    this.flushHints();
    let answer;
    try {
      answer = await this.send('list', { page, ownershipLinks });
    } catch {
      return null;
    }
    if (answer.status === 'ok') return { rows: answer.rows, more: answer.more };
    if (answer.final && this.state === 'active') this.state = 'off';
    return null;
  }

  verifyFiles() {
    if (!this.usable()) return Promise.resolve();
    return this.send('verifyFiles').catch(noop);
  }

  /** Test/benchmark seams. */
  status() {
    return this.send('status');
  }
  shadow() {
    return this.send('shadow');
  }
  settled() {
    this.flushHints();
    return this.send('settle');
  }
  testExec(sql, params = []) {
    return this.send('testExec', { sql, params });
  }

  async close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.flushHandle) clearImmediate(this.flushHandle);
    this.flushHandle = null;
    this.hints.clear();
    // Only a running worker can hold the DB open.
    if (requestWorker?.running()) {
      await request({ op: 'close', dataDir: this.dataDir }).catch(noop);
    }
  }
}

// ── Test seams ──────────────────────────────────────────────────────────────
/** Test seam: `{ writer, enabled, sqliteVersion, backfillBatch,
 *  shadowIntervalMs, retryMs, fenceTimeoutMs, crashAfterBatches, log }`;
 *  null restores defaults. */
export function configureSessionCatalogDbForTest(options) {
  testOptions = options ? { ...options } : null;
}

/** Test seam: post a storage hint tagged with `dataDir` (another data dir's
 *  hint must be ignored by the worker). */
export function postSessionCatalogHintForTest(dataDir, ids) {
  return request({ op: 'hint', dataDir, ids });
}
