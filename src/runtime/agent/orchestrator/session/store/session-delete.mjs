/**
 * Hard delete of a session and the strict enumeration that feeds it. The
 * unlink is irreversible, so this owns its own ownership proof at the commit
 * edge plus the full local-state purge that must happen under the same lock
 * (incarnation retirement, pending slots, purge hooks, markers, summary row).
 */
import { unlinkSync } from 'node:fs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { listStoredAgentWorkerLinks } from '../store-agent-worker-rows.mjs';
import { listStoredSessionSummaries } from './listing.mjs';
import { STORED_SESSION_UNREADABLE, _storedSessionFromFile } from './serialize.mjs';
import { getStoreDir, sessionPath } from './session-paths.mjs';
import {
  readCanonicalSessionRecord as _readCanonicalRecord,
  CANONICAL_RECORD_UNREADABLE as LIFECYCLE_AMBIGUOUS,
  setAsideDamagedSessionRecord,
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
  _liveSessions,
  _retireSessionIncarnation,
  _clearSessionSaveState,
  clearSessionLifecycleCommitError,
  fenceSessionWrites,
} from './live-state.mjs';
import { purgeSessionSaveBookkeeping as _purgeSessionSaveBookkeeping } from './save-worker.mjs';
import { _uncacheSessionSummary, _queueSessionSummaryRemoval, _cachedSummaryRows } from './summary-cache.mjs';
import { _savePending, _clearDebounce, _releasePendingSlot } from './pending-saves.mjs';
import { _runtimeLivenessVeto } from './liveness-veto.mjs';
import { _runSessionPurgeHooks } from './session-observers.mjs';
import { deleteCompactionArchive } from '../compaction-archive.mjs';

/** Child-agent session ids linked to one visible parent. Candidates come from
 * metadata only (the summary rows and the agent-worker links — no folder
 * scan); each candidate's own file is then read strictly and must still be an
 * agent-owned record linked to this parent, so a stale/foreign metadata row
 * can never name a deletion target. Parent deletion no longer removes these
 * children; they outlive the parent as independent sessions. */
export function listOwnedAgentSessionIds(ownerSessionId) {
  const ownerId = String(ownerSessionId || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(ownerId)) return [];
  const linksTo = (row) => row?.ownerSessionId === ownerId || row?.parentSessionId === ownerId;
  const candidates = new Set();
  for (const row of [...listStoredSessionSummaries(), ...listStoredAgentWorkerLinks()]) {
    const candidateId = String(row?.id || row?.sessionId || '').trim();
    if (linksTo(row) && candidateId !== ownerId && /^[A-Za-z0-9_-]+$/.test(candidateId)) {
      candidates.add(candidateId);
    }
  }
  const dir = getStoreDir();
  const ids = [];
  for (const candidateId of candidates) {
    const session = _storedSessionFromFile(dir, `${candidateId}.json`, false);
    // Unreadable, vanished, corrupt or foreign records are never deletion targets.
    if (!session || session === STORED_SESSION_UNREADABLE || !isAgentOwner(session)) continue;
    const linkedOwner = String(session.ownerSessionId || session.parentSessionId || '').trim();
    if (linkedOwner === ownerId) ids.push(candidateId);
  }
  return ids;
}

/** Working folders the session is known to have used (its cached summary row
 *  and live snapshot — no file read, no scan); the purge hooks derive
 *  per-folder artifacts such as the transcript path from them. */
function knownSessionCwds(id) {
  const row = _cachedSummaryRows()?.find((candidate) => candidate.id === id);
  const live = _liveSessions.get(id);
  const cwds = [row?.cwd, row?.workspace?.cwd, row?.workspace?.projectPath, live?.cwd];
  return [...new Set(cwds.filter((cwd) => typeof cwd === 'string' && cwd))];
}

export function deleteSession(id, options = {}) {
  // Keep caller probes and all vetoes ahead of the non-reentrant lock and
  // ahead of pending-save disruption, matching markSessionClosed().
  if (_runtimeLivenessVeto(id, options)) return false;
  const deleteGuard = _guardedSaveOptions(id);
  const commitControl = _acquireWriteCommit(deleteGuard);
  if (commitControl === false) return false;
  try {
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
      let record = _readCanonicalRecord(path);
      // A record that holds no data or is not JSON is damage, not somebody's
      // session: keep its bytes aside so the delete can finish.
      if (record === null || record === LIFECYCLE_AMBIGUOUS) {
        try {
          if (setAsideDamagedSessionRecord(path)) record = null;
        } catch {
          return false; // could not move it: nothing was deleted
        }
      }
      if (record === LIFECYCLE_AMBIGUOUS) return false;
      if (record !== null) {
        // Damage-only mode (a caller's no-data verdict was taken before this
        // lock): content that is valid now was repaired or republished since,
        // and is never deleted.
        if (options.damagedOnly === true) return false;
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
    // An explicit user delete also fences the id: a still-running turn's later
    // saves get fresh guards/incarnations and would otherwise recreate the file.
    if (options.fenceWrites === true) fenceSessionWrites(id);
    _cancelSessionWrites(id);
    _clearDebounce(id);
    _releasePendingSlot(_savePending.get(id));
    _savePending.delete(id);
    _purgeSessionSaveBookkeeping(id);
    _runSessionPurgeHooks(id, { cwds: knownSessionCwds(id) });
    // The display-only compaction archive has no meaning without its session.
    deleteCompactionArchive(getStoreDir(), id);
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
