/**
 * Delta log of the session summary index (leaf: fs/path only, so the cold
 * desktop catalog reader can use it without pulling in lock writers).
 *
 * Layout: `session-summaries.json` stays the compacted base (version 2, exactly
 * the historical format). Per-session changes are appended as one JSON line
 * each to `session-summaries.log` and replayed over the base by every reader;
 * a compaction (store-summary-index.mjs, under the index lock) folds the log
 * into the base and empties it. A session update therefore costs one appended
 * line instead of rewriting every session.
 *
 * Line format (one JSON object per line):
 *   {"u": <summary row>}    upsert the row keyed by its id
 *   {"r": ["id", ...]}      remove these ids
 * Replay is last-writer-wins per id, so re-applying a log that a crashed
 * compaction already folded into the base is harmless. Unparseable lines (a
 * torn tail) are skipped.
 */
import { dirname, join } from 'node:path';
import { runFsStepsSync } from './store/fs-steps.mjs';

const SUMMARY_LOG_FILENAME = 'session-summaries.log';

export function summaryLogPath(indexPath) {
  return join(dirname(indexPath), SUMMARY_LOG_FILENAME);
}

// The leading newline terminates a torn tail left by a crashed append, so it
// can never fuse with (and corrupt) the first record of this one.
export function encodeSummaryOps(upserts, removals) {
  let text = '\n';
  for (const row of upserts) text += `${JSON.stringify({ u: row })}\n`;
  const ids = [...removals];
  if (ids.length > 0) text += `${JSON.stringify({ r: ids })}\n`;
  return text;
}

/** The log text, or '' when it is absent/unreadable. Read it BEFORE the base:
 *  a compaction landing between the two reads then replays already-folded ops
 *  (harmless) instead of hiding ops the new base has and the old one lacks. */
export function readSummaryLogText(indexPath) {
  return runFsStepsSync(readSummaryLogTextStep(indexPath));
}

/** readSummaryLogText as a store-read step (store/fs-steps.mjs). */
export function* readSummaryLogTextStep(indexPath) {
  try {
    return yield ['readFile', summaryLogPath(indexPath), 'utf8'];
  } catch {
    return '';
  }
}

/** The identity of the base file (a compaction replaces it, so it changes
 *  whatever the bytes), or null when it cannot be stat'ed. */
export function* summaryBaseIdentityStep(indexPath) {
  try {
    const info = yield ['stat', indexPath, { bigint: true }];
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return null;
  }
}

/** Attempts at one consistent read: the second exists for the one compaction
 *  that lands inside the first. Two in a row are not a read, and the caller
 *  treats the index as unreadable (the session files are the authority then). */
export const SUMMARY_PAIR_ATTEMPTS = 2;

/**
 * The delta log and the base as ONE pair. A compaction writes the new base and
 * then empties the log, with no lock a reader takes; a log read before it
 * replayed over a base read after it puts older rows over newer ones. The
 * base's identity is taken before the reads and after them, and a pair read
 * across a replacement is read again. `readLog()` and `readBase()` are the
 * caller's own read steps; the result is `{ log, base }`, or null when no
 * attempt came out whole.
 */
export function* readSummaryIndexPairSteps(indexPath, readLog, readBase) {
  for (let attempt = 0; attempt < SUMMARY_PAIR_ATTEMPTS; attempt += 1) {
    const before = yield* summaryBaseIdentityStep(indexPath);
    const log = yield* readLog();
    const base = yield* readBase();
    if ((yield* summaryBaseIdentityStep(indexPath)) === before) return { log, base };
  }
  return null;
}

/** `raw` (parsed base) with the log's ops replayed over its rows. */
export function applySummaryLogText(raw, logText) {
  if (!logText || !raw || typeof raw !== 'object') return raw;
  const byId = new Map();
  for (const row of Array.isArray(raw.rows) ? raw.rows : []) {
    if (row && typeof row.id === 'string') byId.set(row.id, row);
  }
  for (const line of logText.split('\n')) {
    if (!line) continue;
    let op;
    try {
      op = JSON.parse(line);
    } catch {
      continue;
    }
    if (op?.u && typeof op.u.id === 'string') byId.set(op.u.id, op.u);
    else if (Array.isArray(op?.r)) for (const id of op.r) byId.delete(id);
  }
  return { ...raw, rows: [...byId.values()] };
}

/** Change stamp of base + log: the newest mtime of either (0 when neither exists). */
export function summaryIndexStampMs(indexPath) {
  return runFsStepsSync(summaryIndexStampMsStep(indexPath));
}

/** summaryIndexStampMs as a store-read step (store/fs-steps.mjs). */
export function* summaryIndexStampMsStep(indexPath) {
  let stamp = 0;
  for (const path of [indexPath, summaryLogPath(indexPath)]) {
    try {
      stamp = Math.max(stamp, (yield ['stat', path]).mtimeMs || 0);
    } catch {
      /* absent */
    }
  }
  return stamp;
}
