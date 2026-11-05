/**
 * Startup migration: every legacy `<id>.json` without a `<id>.log.jsonl`
 * becomes one, through the same conversion a session's first write uses
 * (prepareLegacyBase + publishLegacyBase = convertLegacySession). The json
 * is only read. Runs after boot, one file at a time with a yield between
 * files; the build-and-prove half runs in a worker thread, only the publish
 * (under the session's writer claim) on the caller's loop.
 *
 * Progress lives in one file (`progressPath`):
 *   { v, migrationId, cursor, complete, updatedAt,
 *     skipped: { [id]: { reason, size, mtimeMs, at, message } } }
 * A file's own commit is its published log, so a crash or exit loses at most
 * the file in progress (its temp file is never published unproven). Skips are
 * permanent for the fingerprint (size, mtimeMs) they were taken at only when
 * they say something about the file (`verify-mismatch`, `unreadable`,
 * `changed`): a changed json is tried again. `busy` (claim held by another
 * process) and `failed` (anything else: disk full, too many open files, I/O,
 * a sharing violation — the machine, not the file) are retried at every start.
 */
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { writeJsonAtomicAsync } from '../../../../shared/atomic-file.mjs';
import { SESSION_LOG_MIGRATION_ID, SESSION_LOG_SUFFIX, fileFingerprint, sameFingerprint } from './session-log-format.mjs';
import { SESSION_LOG_ERRORS, publishLegacyBase } from './session-log-writer.mjs';

const PROGRESS_VERSION = 1;
const PROGRESS_FILE = 'session-log-migration.json';

/** The migration progress file of a data dir (outside `sessions/`: an older
 *  build globs `sessions/*.json`). */
export function sessionLogMigrationProgressPath(dataDir) {
  return join(dataDir, PROGRESS_FILE);
}
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export const MIGRATION_SKIP = Object.freeze({
  BUSY: 'busy',
  VERIFY_MISMATCH: 'verify-mismatch',
  UNREADABLE: 'unreadable',
  CHANGED: 'changed',
  FAILED: 'failed',
});

// Skips retried at every start, whatever the file's fingerprint.
const RETRIED_SKIPS = new Set([MIGRATION_SKIP.BUSY, MIGRATION_SKIP.FAILED]);

function skipReason(code) {
  switch (code) {
    case SESSION_LOG_ERRORS.LEGACY_BASE:
      return MIGRATION_SKIP.VERIFY_MISMATCH;
    case SESSION_LOG_ERRORS.LEGACY_UNREADABLE:
      return MIGRATION_SKIP.UNREADABLE;
    case SESSION_LOG_ERRORS.LEGACY_CHANGED:
      return MIGRATION_SKIP.CHANGED;
    default:
      return MIGRATION_SKIP.FAILED;
  }
}

function freshProgress() {
  return { v: PROGRESS_VERSION, migrationId: SESSION_LOG_MIGRATION_ID, cursor: null, complete: false, updatedAt: 0, skipped: {} };
}

/** The progress record, or a fresh one when there is none. A file that is not
 *  one throws: its skips are user-visible state and are never guessed. */
export async function readMigrationProgress(progressPath) {
  let text;
  try {
    text = await readFile(progressPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return freshProgress();
    throw err;
  }
  const value = JSON.parse(text);
  const valid =
    value?.v === PROGRESS_VERSION &&
    value.migrationId === SESSION_LOG_MIGRATION_ID &&
    (value.cursor === null || typeof value.cursor === 'string') &&
    typeof value.complete === 'boolean' &&
    value.skipped &&
    typeof value.skipped === 'object' &&
    !Array.isArray(value.skipped);
  if (!valid) throw new Error(`[session-log-migration] not a migration progress file: ${progressPath}`);
  return value;
}

function writeProgress(progressPath, progress) {
  progress.updatedAt = Date.now();
  return writeJsonAtomicAsync(progressPath, progress, { compact: true, fsyncDir: true });
}

/** Legacy ids in `names` (a store dir listing) that have no log. */
export function legacyIdsWithoutLog(names) {
  const logs = new Set();
  const legacy = [];
  for (const name of names) {
    if (name.endsWith(SESSION_LOG_SUFFIX)) logs.add(name.slice(0, -SESSION_LOG_SUFFIX.length));
    else if (name.endsWith('.json') && SESSION_ID_RE.test(name.slice(0, -5))) legacy.push(name.slice(0, -5));
  }
  return legacy.filter((id) => !logs.has(id)).sort();
}

// Ids after the cursor first, then the rest: a resumed run continues where
// the last one stopped and still reaches every file.
function cursorOrder(ids, cursor) {
  if (!cursor) return ids;
  const after = ids.filter((id) => id > cursor);
  return [...after, ...ids.filter((id) => id <= cursor)];
}

function prepareClient(createWorker, loader) {
  const worker = createWorker(new URL('./session-log-migration-worker.mjs', import.meta.url), {
    execArgv: [],
    workerData: { loaderUrl: loader.url, loaderExport: loader.exportName },
  });
  const pending = new Map();
  let seq = 0;
  let broken = null;
  const fail = (err) => {
    broken = err;
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };
  worker.on('message', (reply) => {
    const entry = pending.get(reply.seq);
    if (!entry) return;
    pending.delete(reply.seq);
    entry.resolve(reply);
  });
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`[session-log-migration] worker exited (${code})`)));
  return {
    prepare(jsonPath, logPath) {
      if (broken) return Promise.reject(broken);
      return new Promise((resolve, reject) => {
        seq += 1;
        pending.set(seq, { resolve, reject });
        worker.postMessage({ seq, jsonPath, logPath });
      });
    },
    async close() {
      worker.removeAllListeners('exit');
      await worker.terminate();
    },
  };
}

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Run the migration over `storeDir`.
 *   loader    { url, exportName }: module and export of the strict legacy
 *             loader `(text) => session | null` (imported by the worker)
 *   claimFor  (id) => { held, claim: { assertHeld }, release() }
 *   signal    stops between files (exit)
 * Resolves with { total, migrated, converted, skipped: {reason: n}, bytes,
 * ms, aborted, complete }.
 */
export async function migrateLegacySessions({
  storeDir,
  progressPath,
  loader,
  claimFor,
  signal = null,
  log = () => {},
  createWorker = (url, options) => new Worker(url, options),
}) {
  const startedAt = Date.now();
  const progress = await readMigrationProgress(progressPath);
  for (const [id, skip] of Object.entries(progress.skipped)) {
    if (RETRIED_SKIPS.has(skip.reason)) delete progress.skipped[id];
  }
  const ids = cursorOrder(legacyIdsWithoutLog(await readdir(storeDir)), progress.cursor);
  const report = { total: ids.length, migrated: 0, converted: 0, skipped: {}, bytes: 0, ms: 0, aborted: false, complete: false };
  const count = (reason) => {
    report.skipped[reason] = (report.skipped[reason] || 0) + 1;
  };
  let client = null;
  try {
    for (const id of ids) {
      if (signal?.aborted) {
        report.aborted = true;
        break;
      }
      await yieldTurn();
      const jsonPath = join(storeDir, `${id}.json`);
      const logPath = join(storeDir, `${id}${SESSION_LOG_SUFFIX}`);
      const jsonStat = await statOrNull(jsonPath);
      if (!jsonStat) {
        delete progress.skipped[id];
        continue;
      }
      const fingerprint = fileFingerprint(jsonStat);
      const skip = progress.skipped[id];
      if (skip && sameFingerprint(skip, fingerprint)) {
        count(skip.reason);
        continue;
      }
      // Converted by a write since the listing.
      if (await statOrNull(logPath)) {
        delete progress.skipped[id];
        report.converted += 1;
        continue;
      }
      const record = (reason, message) => {
        progress.skipped[id] = { reason, ...fingerprint, at: Date.now(), message };
        count(reason);
        log(`skip ${id}: ${reason}${message ? ` (${message})` : ''}`);
      };
      client ??= prepareClient(createWorker, loader);
      const reply = await client.prepare(jsonPath, logPath);
      if (!reply.ok) {
        if (reply.code !== 'ENOENT') record(skipReason(reply.code), reply.message);
      } else {
        const holder = claimFor(id);
        if (!holder.held) {
          await unlink(reply.prepared.tmpPath).catch(() => {});
          record(MIGRATION_SKIP.BUSY, null);
        } else {
          try {
            await publishLegacyBase(reply.prepared, { claim: holder.claim });
            delete progress.skipped[id];
            report.migrated += 1;
            report.bytes += reply.prepared.size;
          } catch (err) {
            if (err?.code === SESSION_LOG_ERRORS.EXISTS) {
              delete progress.skipped[id];
              report.converted += 1;
            } else {
              record(skipReason(err?.code), String(err?.message || err));
            }
          } finally {
            holder.release?.();
          }
        }
      }
      progress.cursor = id;
      await writeProgress(progressPath, progress);
    }
  } finally {
    await client?.close();
  }
  // Complete: every legacy json has a log or a permanent skip.
  const remaining = legacyIdsWithoutLog(await readdir(storeDir)).filter(
    (id) => !progress.skipped[id] || RETRIED_SKIPS.has(progress.skipped[id].reason)
  );
  progress.complete = !report.aborted && remaining.length === 0;
  await writeProgress(progressPath, progress);
  report.complete = progress.complete;
  report.ms = Date.now() - startedAt;
  return report;
}
