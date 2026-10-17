// sweep/sweep-row.mjs
// The verdict for one candidate row. NOTHING ambiguous is ever swept: this
// code deletes files, plants tombstones and rewrites summary rows, so a record
// it cannot read authoritatively (read fault, malformed JSON, duplicate
// top-level id/closed/generation, foreign id) is left EXACTLY as it is — not
// deleted, not closed, not repaired.
import { readFileSync } from 'node:fs';
import { isHistoricalAutomaticClosure } from '../../historical-session-closure.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../../lifecycle-scan.mjs';
import { sessionPath } from '../session-paths.mjs';
import { probePath, PROBE_PRESENT, PROBE_ABSENT } from '../fs-probe.mjs';
import { _queueSessionSummaryUpsert, _queueSessionSummaryRemoval } from '../summary-cache.mjs';
import { deleteSession } from '../session-delete.mjs';
import { markSessionClosed } from '../lifecycle-barriers.mjs';
import { BLANK_SCRATCH_MAX_AGE_MS, RUNNING_STALL_MS, readSweepRecord } from './sweep-record.mjs';

/** The AUTHORITATIVE on-disk fields, falling back to the best-effort (and
 *  possibly stale) summary row only where the record lacks them — a stale row
 *  must not close or prune the wrong session. */
const effectiveFields = (actual, row) => ({
  owner: actual && typeof actual.owner === 'string' && actual.owner.length > 0 ? actual.owner : row.owner,
  status: actual && typeof actual.status === 'string' ? actual.status : row.status,
  provider: actual && typeof actual.provider === 'string' ? actual.provider : row.provider,
  updatedAt: Number(actual?.updatedAt) > 0 ? Number(actual.updatedAt) : row.updatedAt || 0,
  lastHeartbeatAt: Number(actual?.lastHeartbeatAt) > 0 ? Number(actual.lastHeartbeatAt) : row.lastHeartbeatAt || 0,
  createdAt: Number(actual?.createdAt) > 0 ? Number(actual.createdAt) : row.createdAt || 0,
});

/** A closed record: a mature tombstone is deleted; otherwise a stale summary
 *  row that still claims the session open is repaired and the row is kept. */
function sweepClosedRecord(ctx, row, actual, jsonPath) {
  const { plan, now, tally } = ctx;
  // A shared store can be tombstoned by another process while this process
  // still owns an in-flight controller for the same id. Exclude it before
  // unlinking: clearing only the local runtime after deletion is too late
  // because its eventual save would see no tombstone and could resurrect
  // the session.
  if (plan.isSessionLive?.(row.id)) {
    tally.remaining++;
    return;
  }
  // Closed sessions are EXEMPT from the freshness gate: a tombstone whose
  // file mtime keeps getting bumped would otherwise stay perpetually
  // "fresh" and never mature. Maturity is governed ONLY by the ORIGINAL
  // close time (disk updatedAt, not row.updatedAt which a stale row may
  // carry from before the close).
  const closedAt = Number(actual?.updatedAt ?? row.updatedAt);
  const age = now - closedAt;
  if (plan.sweepTombstones && Number.isFinite(closedAt) && age >= plan.tombstoneMaxAgeMs) {
    try {
      if (deleteSession(row.id, { deferSummaryUpdate: true, legacyOwnerVeto: true })) {
        tally.tombstonesCleaned++;
        tally.tombstoneDetails.push({ id: row.id, ageSeconds: Math.floor(age / 1000) });
        return;
      }
    } catch (err) {
      tally.tombstoneErrors.push({ id: row.id, message: err?.message || String(err) });
      tally.remaining++;
      return;
    }
  }
  // Repair a stale summary row that still claimed the session was open:
  // reflect the real closed state so the next sweep sees the correct
  // closed=true/updatedAt and never re-closes it.
  if (!(row.closed === true || row.status === 'closed')) {
    // The summary projection needs the transcript, which the cached
    // lifecycle record does not carry: re-read this one file for the (rare)
    // repair.
    try {
      const full = readTopLevelLifecycleRecord(readFileSync(jsonPath, 'utf-8'));
      if (!isLifecycleUnreadable(full) && full.id === row.id) _queueSessionSummaryUpsert(full.doc);
    } catch {
      /* best-effort */
    }
  }
  tally.remaining++;
}

/** A USER-owned conversation is never closed or capped. The one exception to
 *  that permanence is a blank scratch: ZERO user/assistant conversation
 *  (engine boot artifact, force-killed window, crashed host) has nothing to
 *  preserve, and relaunch storms otherwise pile hundreds of "(blank)" rows
 *  that no sweep may touch. Reap once cold; the liveness veto inside
 *  deleteSession still protects an in-flight boot, local or in a live older
 *  process. */
function sweepUserOwnedRecord(ctx, row, record, eff) {
  const { plan, now, tally } = ctx;
  const conversationCount = Number.isFinite(record.conversationCount)
    ? record.conversationCount
    : Number(row.messageCount) || 0;
  const lastActive = Math.max(eff.updatedAt, eff.lastHeartbeatAt, eff.createdAt);
  if (
    plan.sweepIdle &&
    conversationCount === 0 &&
    now - lastActive > BLANK_SCRATCH_MAX_AGE_MS &&
    !plan.isSessionLive?.(row.id)
  ) {
    try {
      if (
        deleteSession(row.id, {
          deferSummaryUpdate: true,
          isSessionLive: plan.isSessionLive,
          legacyOwnerVeto: true,
        })
      ) {
        tally.openPruned++;
        tally.openPrunedDetails.push({ id: row.id, ageSeconds: Math.floor((now - lastActive) / 1000) });
        return;
      }
    } catch {
      /* keep the row on failure */
    }
  }
  tally.remaining++;
}

/** Closes an idle session. Close is destructive, so the in-memory runtime
 *  ownership is re-checked at the commit edge. */
function closeIdleRecord(ctx, row, eff, { lastActive }) {
  const { plan, now, tally } = ctx;
  if (plan.isSessionLive?.(row.id)) {
    tally.remaining++;
    return;
  }
  let closeResult = null;
  try {
    closeResult = markSessionClosed(row.id, 'idle-sweep', { isSessionLive: plan.isSessionLive, legacyOwnerVeto: true });
  } catch (err) {
    process.stderr.write(`[session-store] idle-sweep close failed for ${row.id}: ${err?.message}\n`);
    return;
  }
  if (closeResult == null) {
    tally.remaining++;
    return;
  }
  tally.cleaned++;
  tally.details.push({
    id: row.id,
    owner: eff.owner || 'unknown',
    idleMinutes: Math.round((now - lastActive) / 60000),
  });
}

/** An open record: the freshness gate, then user permanence, the running
 *  backstop, the idle close, or a retention-cap candidacy. */
function sweepOpenRecord(ctx, row, record, { jsonMtime }) {
  const { plan, now, tally } = ctx;
  const eff = effectiveFields(record.doc, row);
  const ownerNamed = typeof eff.owner === 'string' && eff.owner.length > 0;
  // Freshness gate — recently-touched open sessions are skipped cheaply here.
  let freshnessGateMs = 0;
  if (plan.sweepIdle) freshnessGateMs = plan.maxAge;
  else if (plan.sweepTombstones) freshnessGateMs = plan.tombstoneMaxAgeMs;
  const newestKnown = Math.max(row.updatedAt || 0, row.lastHeartbeatAt || 0, row.createdAt || 0, jsonMtime);
  if (freshnessGateMs > 0 && newestKnown > 0 && now - newestKnown <= freshnessGateMs) {
    // Fresh agent/legacy sessions survive idle close but still participate
    // in the resumable-open retention cap. The cap performs its own
    // commit-edge liveness veto before deletion.
    if (plan.retainOpen && plan.sweepIdle && !ownerNamed) {
      tally.openCandidates.push({ id: row.id, lastActive: newestKnown });
    }
    tally.remaining++;
    return;
  }
  // Every explicitly owned conversation has the same retention policy.
  // Only ownerless legacy records enter idle closure and the retention cap.
  if (ownerNamed) {
    sweepUserOwnedRecord(ctx, row, record, eff);
    return;
  }
  if (!plan.sweepIdle) {
    tally.remaining++;
    return;
  }
  // The manager may sweep while unrelated sessions are active. Protect this
  // specific locally-current/in-flight session regardless of stale on-disk
  // timestamps; its in-memory runtime decides when it is safe to become an
  // idle-sweep candidate.
  if (plan.isSessionLive?.(row.id)) {
    tally.remaining++;
    return;
  }
  const lastActive = eff.lastHeartbeatAt || eff.updatedAt || eff.createdAt || 0;
  // Running sessions are normally reaped by the stream-watchdog within
  // ~120s. Skip them here unless they've been silent past RUNNING_STALL_MS,
  // at which point they are treated as zombies.
  if (eff.status === 'running' && now - lastActive <= RUNNING_STALL_MS) {
    tally.remaining++;
    return;
  }
  if (now - lastActive > plan.maxAge) {
    closeIdleRecord(ctx, row, eff, { lastActive });
    return;
  }
  if (plan.retainOpen) tally.openCandidates.push({ id: row.id, lastActive });
  tally.remaining++;
}

export function sweepRow(ctx, row) {
  if (!row?.id) return;
  const { tally } = ctx;
  const jsonPath = sessionPath(row.id);
  const jsonProbe = probePath(jsonPath);
  // ONLY a proven-absent record may retire its summary row. An EACCES/EIO
  // probe means the file is very likely still there: queueing a removal
  // would delete the row of a live session.
  if (jsonProbe.state === PROBE_ABSENT) {
    _queueSessionSummaryRemoval(row.id);
    return;
  }
  if (jsonProbe.state !== PROBE_PRESENT) {
    tally.remaining++;
    return;
  }
  // Truth source: the summary index is a deferred/best-effort sidecar, so a
  // row can still claim status='idle'/open while the session JSON was
  // already tombstoned. Read the real session JSON BEFORE the freshness gate
  // so closed-ness is decided from AUTHORITATIVE on-disk state — otherwise
  // idle-sweep re-closes an already-closed session via markSessionClosed
  // (which, pre-fix, reset the tombstone age every 5-min cycle →
  // immortality loop). A racing unlink / transient read failure, an
  // unreadable record, or a record naming another id (including a foreign
  // TOMBSTONE that would look perfectly mature) is preserved untouched.
  const record = readSweepRecord(row.id, jsonPath, jsonProbe);
  if (record === null || isLifecycleUnreadable(record) || record.id !== row.id) {
    tally.remaining++;
    return;
  }
  // One strict parse for the whole record: every decision below reads the
  // SAME authoritative document (owner/status/timestamps/messages).
  const actual = record.doc;
  if (isHistoricalAutomaticClosure(actual)) {
    tally.remaining++;
    return;
  }
  if (record.closed === true || actual.status === 'closed') {
    sweepClosedRecord(ctx, row, actual, jsonPath);
    return;
  }
  sweepOpenRecord(ctx, row, record, { jsonMtime: jsonProbe.mtimeMs || 0 });
}
