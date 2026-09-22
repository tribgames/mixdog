/**
 * Hard delete of a session and the strict enumeration that feeds it. The
 * unlink is irreversible, so this owns its own ownership proof at the commit
 * edge plus the full local-state purge that must happen under the same lock
 * (incarnation retirement, pending slots, purge hooks, markers, summary row).
 */
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isAgentOwner } from '../../agent-owner.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../lifecycle-scan.mjs';
import { getStoreDir, sessionPath, deleteSessionPresence } from './paths-heartbeat.mjs';
import {
  readCanonicalSessionRecord as _readCanonicalRecord,
  CANONICAL_RECORD_UNREADABLE as LIFECYCLE_AMBIGUOUS,
} from './canonical-reader.mjs';
import { probePath, PROBE_PRESENT, PROBE_ABSENT } from './fs-probe.mjs';
import {
  guardedSaveOptions as _guardedSaveOptions,
  cancelSessionWrites as _cancelSessionWrites,
  acquireWriteCommit as _acquireWriteCommit,
  releaseWriteCommit as _releaseWriteCommit,
} from './write-guards.mjs';
import {
  _clearLiveSession,
  _retireSessionIncarnation,
  _clearSessionSaveState,
  clearSessionLifecycleCommitError,
} from './live-state.mjs';
import { purgeSessionSaveBookkeeping as _purgeSessionSaveBookkeeping } from './save-worker.mjs';
import { _uncacheSessionSummary, _queueSessionSummaryRemoval } from './summary-cache.mjs';
import { _savePending, _clearDebounce, _releasePendingSlot } from './pending-saves.mjs';
import { _runtimeLivenessVeto, _heartbeatLivenessVeto, _deleteHeartbeatUnlessNewer } from './liveness-veto.mjs';
import { _runSessionPurgeHooks } from './session-observers.mjs';

/** Strictly enumerate child-agent session files linked to one visible parent.
 * Used only by explicit parent deletion; ordinary close/context switches keep
 * the relationship intact. */
export function listOwnedAgentSessionIds(ownerSessionId) {
  const ownerId = String(ownerSessionId || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(ownerId)) return [];
  const dir = getStoreDir();
  if (probePath(dir).state !== PROBE_PRESENT) return [];
  let files;
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  const ids = [];
  for (const file of files) {
    const candidateId = file.slice(0, -5);
    if (!candidateId || candidateId === ownerId || !/^[A-Za-z0-9_-]+$/.test(candidateId)) continue;
    try {
      const record = readTopLevelLifecycleRecord(readFileSync(join(dir, file), 'utf8'));
      if (isLifecycleUnreadable(record) || record.id !== candidateId) continue;
      const session = record.doc;
      if (!isAgentOwner(session)) continue;
      const linkedOwner = String(session.ownerSessionId || session.parentSessionId || '').trim();
      if (linkedOwner === ownerId) ids.push(candidateId);
    } catch {
      /* unreadable/vanished records are never deletion targets */
    }
  }
  return ids;
}

export function deleteSession(id, options = {}) {
  // Keep caller probes and all vetoes ahead of the non-reentrant lock and
  // ahead of pending-save disruption, matching markSessionClosed().
  if (_runtimeLivenessVeto(id, options) || _heartbeatLivenessVeto(id, options)) return false;
  const deleteGuard = _guardedSaveOptions(id);
  const commitControl = _acquireWriteCommit(deleteGuard);
  if (commitControl === false) return false;
  try {
    // Cross-process revival after full-TTL silence remains best-effort; the
    // tombstone resurrection guard is authoritative. Only re-stat .hb here.
    if (_heartbeatLivenessVeto(id, options)) return false;
    // ── 1. unlink FIRST, still holding the commit lock ─────────────────────
    // A failed unlink is NOT a delete: the canonical bytes are still there, so
    // nothing may be purged, cancelled or closed — every pending write, parked
    // snapshot and metrics timer stays usable and persistable.
    const path = sessionPath(id);
    const probe = probePath(path);
    // An unreadable probe is NOT absence: purging markers/pending state while
    // the canonical bytes survive would strand a live session behind a file
    // nobody owns any more. Nothing was deleted, so report exactly that.
    if (probe.state !== PROBE_PRESENT && probe.state !== PROBE_ABSENT) return false;
    // CONTRACT: an ABSENT canonical record is a SUCCESSFUL (idempotent)
    // delete — the session does not exist once this call returns, so the id's
    // local state is purged and `true` is reported. `false` is reserved for
    // "nothing was deleted AND nothing was mutated": a liveness veto, a
    // contended commit lock, an unreadable probe, ambiguous/foreign bytes, or
    // a failed unlink.
    if (probe.state === PROBE_PRESENT) {
      // STRICT OWNERSHIP AT THE COMMIT EDGE. The bytes are re-read here,
      // under the same commit lock, immediately before the unlink — not
      // inferred from the earlier stat, and not from any cache: between the
      // probe and this read another process can rename a different session's
      // record (or a torn write) onto this path, and an unlink is
      // irreversible. Ambiguous/foreign bytes are therefore never deleted.
      const record = _readCanonicalRecord(path);
      if (record === LIFECYCLE_AMBIGUOUS) return false;
      if (record !== null) {
        if (record.id !== id) return false;
        try {
          unlinkSync(path);
        } catch {
          return false; // canonical file survives → nothing was deleted
        }
      }
      // record === null: the file vanished inside this window — fall through
      // to the absent contract (nothing removed, local state still purged).
    }
    // ── 2. finalize UNDER THE SAME LOCK ────────────────────────────────────
    // The file is gone. Cancellation + purge happen before the lock is
    // released, so a writer waiting for the lock is refused by its own
    // cancellation re-check instead of renaming the file back, and no parked
    // snapshot, timer or deferred entry survives to resurrect it.
    // Retire the id's incarnation: every write, queued payload and parked
    // snapshot stamped BEFORE this point becomes permanently non-current, so
    // its settlement moves no marker and touches no bookkeeping — and a
    // re-created id gets a brand new incarnation of its own.
    _retireSessionIncarnation(id);
    _cancelSessionWrites(id);
    _clearDebounce(id);
    _releasePendingSlot(_savePending.get(id));
    _savePending.delete(id);
    _purgeSessionSaveBookkeeping(id);
    _runSessionPurgeHooks(id);
    // Preserve a sidecar published strictly after the sweep's scan snapshot.
    _deleteHeartbeatUnlessNewer(id, options);
    deleteSessionPresence(id);
    _clearLiveSession(id);
    // The file is gone: every marker of the retired incarnation goes with it
    // (save error + failed-snapshot evidence, split-brain drop flag, lifecycle
    // commit error), so a re-created id starts clean.
    _clearSessionSaveState(id);
    clearSessionLifecycleCommitError(id);
    // deferSummaryUpdate: bulk callers (tombstone sweep) remove thousands of
    // rows — a per-id _removeSessionSummary would parse+rewrite the multi-MB
    // summary index once PER DELETION. They batch the index update themselves.
    if (options.deferSummaryUpdate === true) _uncacheSessionSummary(id);
    else _queueSessionSummaryRemoval(id);
    // Both PRESENT-and-unlinked and ABSENT reach here: the session is gone.
    return true;
  } finally {
    _releaseWriteCommit(commitControl);
  }
}
