// sweep/sweep-finish.mjs
// What runs after every row has its verdict: the resumable-open retention
// cap, the orphan sidecar reap, and the one batched summary-index prune.
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { probePath, PROBE_PRESENT, PROBE_ABSENT } from '../fs-probe.mjs';
import { _queueSummaryIndexPrune } from '../summary-cache.mjs';
import { deleteSession } from '../../store.mjs';

/** Retention cap: prune resumable open (non-tombstone) sessions newest-first
 *  — keep the most recent openMaxCount, prune anything older than openMaxAgeMs
 *  OR beyond the count. Live/current sessions (isSessionLive) are never pruned
 *  but still occupy a kept slot. */
export function pruneOpenCandidates({ plan, now, tally }) {
  if (!plan.retainOpen || tally.openCandidates.length === 0) return;
  tally.openCandidates.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  let kept = 0;
  for (const c of tally.openCandidates) {
    if (plan.isSessionLive?.(c.id)) {
      kept++;
      continue;
    }
    const tooOld = plan.openMaxAgeMs > 0 && now - (c.lastActive || 0) > plan.openMaxAgeMs;
    const overCount = kept >= plan.openMaxCount;
    if (!tooOld && !overCount) {
      kept++;
      continue;
    }
    try {
      if (
        deleteSession(c.id, {
          deferSummaryUpdate: true,
          isSessionLive: plan.isSessionLive,
          heartbeatSnapshotMtime: c.heartbeatSnapshotMtime,
          heartbeatFreshMs: c.heartbeatFreshMs,
        })
      ) {
        tally.openPruned++;
        tally.openPrunedDetails.push({ id: c.id, ageSeconds: Math.floor((now - (c.lastActive || 0)) / 1000) });
        if (tally.remaining > 0) tally.remaining--;
      } else {
        kept++;
      }
    } catch {
      kept++;
    }
  }
}

/** Orphan .hb/.own reap: a heartbeat/presence sidecar whose .json no longer
 *  exists is dead weight once it is also stale (older than maxAge) — the
 *  session JSON was swept/closed but the sidecar lingered (crashed owner or
 *  pre-fix orphan). The staleness gate avoids nuking the sidecar of a session
 *  mid-create whose .json write has not landed yet. Yields between sidecars
 *  like the row loop. */
export function* reapOrphanSidecars({ plan, dir, now, tally }) {
  try {
    for (const h of readdirSync(dir).filter((f) => f.endsWith('.hb') || f.endsWith('.own'))) {
      yield undefined;
      // Only a PROVEN-absent session file makes its sidecar an orphan.
      if (probePath(join(dir, h.replace(/\.(hb|own)$/, '.json'))).state !== PROBE_ABSENT) continue;
      const sidecarProbe = probePath(join(dir, h));
      if (sidecarProbe.state !== PROBE_PRESENT) continue;
      if (now - sidecarProbe.mtimeMs > plan.maxAge) {
        try {
          unlinkSync(join(dir, h));
          tally.cleaned++;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* dir scan failure — non-fatal */
  }
}

/** Batched summary-index prune for deferred tombstone deletions: one
 *  read-modify-write for the whole sweep instead of one per deleted id (the
 *  index is multi-MB at scale; per-id rewrites made large sweeps quadratic
 *  and stalled boot for seconds). */
export function queueDeletedSummaryPrune(tally) {
  if (tally.tombstoneDetails.length === 0 && tally.openPrunedDetails.length === 0) return;
  try {
    const deletedIds = new Set([...tally.tombstoneDetails, ...tally.openPrunedDetails].map((d) => d.id));
    _queueSummaryIndexPrune(deletedIds);
  } catch {
    /* summary index is best-effort */
  }
}
