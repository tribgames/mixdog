// sweep/sweep-finish.mjs
// What runs after every row has its verdict: the resumable-open retention
// cap, the legacy/orphan sidecar reap, and the one batched summary-index prune.
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hasPendingSessionWrite } from '../pending-writes.mjs';
import { ABSENT_RECORD_STAMP, sessionRecordStampOfSync } from '../session-record.mjs';
import { _queueSummaryIndexPrune } from '../summary-cache.mjs';
import { deleteSession } from '../session-delete.mjs';
import { COMPACTION_ARCHIVE_SUFFIX } from '../../compaction-archive.mjs';
import { LEGACY_MARKER_SUFFIXES, readLegacyMarker } from '../liveness-veto.mjs';

/** Retention cap: prune resumable open (non-tombstone) sessions newest-first
 *  — keep the most recent openMaxCount, prune anything older than openMaxAgeMs
 *  OR beyond the count. Live/current sessions (isSessionLive) are never pruned
 *  but still occupy a kept slot. */
export async function pruneOpenCandidates({ plan, now, tally }) {
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
        await deleteSession(c.id, {
          deferSummaryUpdate: true,
          isSessionLive: plan.isSessionLive,
          legacyOwnerVeto: true,
          // A commit still landing makes the candidate's age stale: kept.
          singleAttempt: true,
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

// Only a record whose stat is PROVEN absent (neither file) is gone: an
// EACCES/EIO stat means it is very likely still there.
function sessionRecordProvenAbsent(dir, id) {
  try {
    return sessionRecordStampOfSync(dir, id) === ABSENT_RECORD_STAMP;
  } catch {
    return false;
  }
}

/** Legacy `.hb` heartbeat and `.own` presence sidecars are written by no
 *  current build, but an older Mixdog process still running mid-upgrade keeps
 *  publishing them. One is reaped only once it holds nothing: its recorded
 *  owner pid is dead or it went stale; a fresh marker of a live (or
 *  unrecorded) owner is kept. Orphan compaction-archive reap: an archive goes
 *  with its session, so one whose session record (log or legacy json, by the
 *  record seam) is proven absent is dead weight — the session was swept or
 *  closed but the archive lingered. A session whose save is still pending has
 *  no record yet but is not gone (that save creates it), so it keeps its
 *  archive. Yields between sidecars like the row loop. */
export function* reapOrphanSidecars({ dir, now, tally }) {
  const unlinkSidecar = (h) => {
    try {
      unlinkSync(join(dir, h));
      tally.cleaned++;
    } catch {
      /* ignore */
    }
  };
  try {
    for (const h of readdirSync(dir).filter(
      (f) => f.endsWith('.hb') || f.endsWith('.own') || f.endsWith(COMPACTION_ARCHIVE_SUFFIX)
    )) {
      yield undefined;
      if (LEGACY_MARKER_SUFFIXES.some((suffix) => h.endsWith(suffix))) {
        const marker = readLegacyMarker(join(dir, h), now);
        if (marker && (marker.ownerDead || !marker.fresh)) unlinkSidecar(h);
        continue;
      }
      const id = h.slice(0, -COMPACTION_ARCHIVE_SUFFIX.length);
      if (sessionRecordProvenAbsent(dir, id) && !hasPendingSessionWrite(id)) unlinkSidecar(h);
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
