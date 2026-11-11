// sweep/stale-sweep.mjs
// Background sweep of the session store: closes idle sessions, deletes mature
// tombstones and blank scratch, caps resumable open sessions and reaps orphan
// sidecars. It pauses between records so cooperative hosts never hold the
// event loop for a whole directory scan; a close or delete it makes waits
// (asynchronously) for a commit of the same session still landing.
import { getStoreDir, sessionScanCheckpointDir } from '../session-paths.mjs';
import { sweepOrphanScanCheckpoints } from '../session-scan-checkpoint.mjs';
import { probePath, PROBE_PRESENT } from '../fs-probe.mjs';
import { persistSweepRecordCache, pruneSweepRecordCache } from './sweep-record.mjs';
import { collectSweepRows, createSweepTally, resolveSweepPlan } from './sweep-plan.mjs';
import { sweepRow } from './sweep-row.mjs';
import { pruneOpenCandidates, queueDeletedSummaryPrune, reapOrphanSidecars } from './sweep-finish.mjs';

/**
 * Background sweep: delete session files idle longer than ttlMs.
 * Resolves { cleaned, remaining, details } for logging. `pause()` runs between
 * records and sidecars; the pause it returns (if any) is awaited.
 */
async function sweepStaleSessionSteps(ttlMs, options, pause) {
  const plan = resolveSweepPlan(ttlMs, options);
  const dir = getStoreDir();
  // An unreadable store dir is not an empty one: sweeping (deleting,
  // closing, pruning) on a probe we could not make is never allowed.
  if (probePath(dir).state !== PROBE_PRESENT) {
    const { openCandidates: _candidates, subAgents, ...empty } = createSweepTally();
    return plan.retainSubAgents ? { ...empty, subAgents } : empty;
  }
  const rows = collectSweepRows(dir);
  pruneSweepRecordCache(new Set(rows.map((row) => row?.id).filter(Boolean)));
  const ctx = { plan, dir, now: Date.now(), tally: createSweepTally() };
  for (const row of rows) {
    // Cooperative callers pause between records so large stores never hold
    // an interactive host's event loop for the full directory scan.
    await pause();
    try {
      await sweepRow(ctx, row);
    } catch {
      /* skip corrupt */
    }
  }
  await pruneOpenCandidates(ctx);
  for (const _sidecar of reapOrphanSidecars(ctx)) await pause();
  await sweepOrphanScanCheckpoints(sessionScanCheckpointDir());
  queueDeletedSummaryPrune(ctx.tally);
  persistSweepRecordCache();
  const { openCandidates: _candidates, subAgents, ...result } = ctx.tally;
  // `subAgents` only for a caller that applies them (idle-cleanup.mjs).
  return plan.retainSubAgents ? { ...result, subAgents } : result;
}

/** Unsliced surface for explicit maintenance commands/tests. */
export function sweepStaleSessions(ttlMs, options = {}) {
  return sweepStaleSessionSteps(ttlMs, options, () => undefined);
}

/**
 * Interactive-host sweep: the same lifecycle decisions, yielding a macrotask
 * once a slice is spent. A single large session remains atomic, but a
 * directory worth of reads/parses can no longer become one multi-second task.
 */
export function sweepStaleSessionsCooperative(ttlMs, options = {}) {
  const cooperativeOptions = ttlMs && typeof ttlMs === 'object' ? ttlMs : options;
  const configuredSliceMs = Number(cooperativeOptions?.cooperativeSliceMs);
  const sliceMs = Number.isFinite(configuredSliceMs) ? Math.min(50, Math.max(0, configuredSliceMs)) : 8;
  let sliceStartedAt = performance.now();
  const pause = () => {
    if (performance.now() - sliceStartedAt < sliceMs) return undefined;
    return new Promise((resolve) => setImmediate(resolve)).then(() => {
      sliceStartedAt = performance.now();
    });
  };
  return sweepStaleSessionSteps(ttlMs, options, pause);
}
