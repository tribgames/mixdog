// sweep/sweep-plan.mjs
// One sweep's resolved options (what to sweep and with which bounds), the
// candidate rows it visits, and the tally it fills in.
import { readdirSync } from 'node:fs';
import { loadConfig } from '../../../config.mjs';
import { listStoredSessionSummaries } from '../listing.mjs';
import { DEFAULT_SESSION_TTL_MS, RESUMABLE_OPEN_MAX_AGE_MS, RESUMABLE_OPEN_MAX_COUNT } from './sweep-record.mjs';

export function resolveSweepPlan(ttlMs, options = {}) {
  if (ttlMs && typeof ttlMs === 'object') {
    options = ttlMs;
    ttlMs = options.ttlMs;
  }
  let terminalReapConfig = null;
  try {
    terminalReapConfig = loadConfig({ secrets: false });
  } catch {
    /* built-ins remain available */
  }
  const sweepIdle = options.sweepIdle !== false;
  const tombstoneMaxAgeMs = Number(options.tombstoneMaxAgeMs);
  const optAge = Number(options.openMaxAgeMs);
  const optCount = Number(options.openMaxCount);
  return {
    maxAge: ttlMs || DEFAULT_SESSION_TTL_MS,
    sweepIdle,
    terminalReapConfig,
    tombstoneMaxAgeMs,
    sweepTombstones: Number.isFinite(tombstoneMaxAgeMs) && tombstoneMaxAgeMs > 0,
    // Retention cap for resumable open sessions runs only on the idle sweep
    // (never on a tombstone-only pass). isSessionLive protects the current /
    // actively-running sessions from being pruned by the retention cap.
    isSessionLive: typeof options.isSessionLive === 'function' ? options.isSessionLive : null,
    retainOpen: sweepIdle && options.retainOpenSessions !== false,
    openMaxAgeMs: Number.isFinite(optAge) && optAge > 0 ? optAge : RESUMABLE_OPEN_MAX_AGE_MS,
    openMaxCount: Number.isFinite(optCount) && optCount >= 0 ? optCount : RESUMABLE_OPEN_MAX_COUNT,
  };
}

/** The rows one sweep visits: the summary index reconciled with a direct
 *  directory scan. The index is a best-effort sidecar that can lag far behind
 *  disk (thousands of on-disk .json files may be absent from a smaller
 *  index); any such orphan closed+mature tombstone would otherwise be
 *  unreachable and accumulate forever. Synthetic { id } rows are sufficient
 *  because the sweep re-reads all lifecycle truth from disk. Sweep-local:
 *  listStoredSessionSummaries is unchanged for other callers. */
export function collectSweepRows(dir) {
  const summaries = listStoredSessionSummaries();
  try {
    const seen = new Set();
    for (const row of summaries) {
      if (row?.id) seen.add(row.id);
    }
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      summaries.push({ id });
    }
  } catch {
    /* dir scan failure — fall back to index rows only */
  }
  return summaries;
}

export function createSweepTally() {
  return {
    cleaned: 0,
    remaining: 0,
    details: [],
    tombstonesCleaned: 0,
    tombstoneDetails: [],
    tombstoneErrors: [],
    // Retention-cap bookkeeping: surviving open (non-tombstone) sessions,
    // pruned oldest-first after the main loop.
    openCandidates: [],
    openPruned: 0,
    openPrunedDetails: [],
  };
}
