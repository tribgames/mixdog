// sweep/stale-sweep.mjs
// Background sweep of the session store: closes idle sessions, deletes mature
// tombstones and blank scratch, caps resumable open sessions and reaps orphan
// sidecars. The generator yields between records so cooperative hosts never
// hold the event loop for a whole directory scan; the synchronous wrapper
// drains it in one go.
import { getStoreDir } from '../paths-heartbeat.mjs';
import { probePath, PROBE_PRESENT } from '../fs-probe.mjs';
import { pruneSweepRecordCache } from './sweep-record.mjs';
import { collectSweepRows, createSweepTally, resolveSweepPlan } from './sweep-plan.mjs';
import { sweepRow } from './sweep-row.mjs';
import { pruneOpenCandidates, queueDeletedSummaryPrune, reapOrphanSidecars } from './sweep-finish.mjs';

/**
 * Background sweep: delete session files idle longer than ttlMs.
 * Returns { cleaned, remaining, details } for logging.
 */
function* sweepStaleSessionSteps(ttlMs, options = {}) {
  const plan = resolveSweepPlan(ttlMs, options);
  const dir = getStoreDir();
  // An unreadable store dir is not an empty one: sweeping (deleting,
  // closing, pruning) on a probe we could not make is never allowed.
  if (probePath(dir).state !== PROBE_PRESENT)
    return { cleaned: 0, remaining: 0, details: [], tombstonesCleaned: 0, tombstoneDetails: [], tombstoneErrors: [] };
  const rows = collectSweepRows(dir);
  pruneSweepRecordCache(new Set(rows.map((row) => row?.id).filter(Boolean)));
  const ctx = { plan, dir, now: Date.now(), tally: createSweepTally() };
  for (const row of rows) {
    // Cooperative callers pause between records so large stores never hold
    // an interactive host's event loop for the full directory scan.
    yield undefined;
    try {
      sweepRow(ctx, row);
    } catch {
      /* skip corrupt */
    }
  }
  pruneOpenCandidates(ctx);
  yield* reapOrphanSidecars(ctx);
  queueDeletedSummaryPrune(ctx.tally);
  const { openCandidates: _candidates, ...result } = ctx.tally;
  return result;
}

/** Synchronous compatibility surface for explicit maintenance commands/tests. */
export function sweepStaleSessions(ttlMs, options = {}) {
  const steps = sweepStaleSessionSteps(ttlMs, options);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/**
 * Interactive-host sweep: preserve the exact synchronous lifecycle decisions
 * while yielding between records. A single large session remains atomic, but a
 * directory worth of reads/parses can no longer become one multi-second task.
 */
export async function sweepStaleSessionsCooperative(ttlMs, options = {}) {
  const cooperativeOptions = ttlMs && typeof ttlMs === 'object' ? ttlMs : options;
  const configuredSliceMs = Number(cooperativeOptions?.cooperativeSliceMs);
  const sliceMs = Number.isFinite(configuredSliceMs) ? Math.min(50, Math.max(0, configuredSliceMs)) : 8;
  const steps = sweepStaleSessionSteps(ttlMs, options);
  let next = steps.next();
  while (!next.done) {
    const sliceStartedAt = performance.now();
    do {
      next = steps.next();
    } while (!next.done && performance.now() - sliceStartedAt < sliceMs);
    if (!next.done) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return next.value;
}
