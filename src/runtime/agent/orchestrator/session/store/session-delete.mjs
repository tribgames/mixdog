/**
 * Hard delete of a session and the strict enumeration that feeds it. The
 * unlink is irreversible, so this owns its own ownership proof (each file is
 * read as this session's before it goes) plus the full local-state purge.
 */
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isAgentOwner } from '../../agent-owner.mjs';
import { listStoredAgentWorkerLinks } from '../store-agent-worker-rows.mjs';
import { listStoredSessionSummaries } from './listing.mjs';
import { STORED_SESSION_UNREADABLE } from './serialize.mjs';
import { loadLegacySession } from './legacy-session.mjs';
import { storedSessionSync } from './stored-session.mjs';
import { getStoreDir, sessionLogPath, sessionPath } from './session-paths.mjs';
import { resolveSessionRecordSync } from './session-log-reader.mjs';
import { sha1Hex } from './session-log-format.mjs';
import { holdsNoData, quarantinePath, renameWithRetry } from '../../../../shared/atomic-file.mjs';
import {
  _clearLiveSession,
  _liveSessions,
  _clearSessionSaveState,
  clearSessionLifecycleCommitError,
  fenceSessionWrites,
  _recordLifecycleCommitFailure,
} from './live-state.mjs';
import { claimSessionWriter, forgetSessionWriter, releaseSessionWriter, sessionWriterRefusalError } from './session-writer-claim.mjs';
import { forgetDeletedRecorder, settleRecorder } from './session-writers.mjs';
import { _uncacheSessionSummary, _queueSessionSummaryRemoval, _cachedSummaryRows } from './summary-cache.mjs';
import { takePendingWrite } from './pending-writes.mjs';
import { inSessionOrder } from './session-sequence.mjs';
import { _runtimeLivenessVeto } from './liveness-veto.mjs';
import { _runSessionPurgeHooks } from './session-observers.mjs';
import { forgetSessionLoadCache } from './load-cache.mjs';
import { deleteCompactionArchive } from '../compaction-archive.mjs';
import { removeSessionScratchDir } from '../../../../shared/session-scratch.mjs';

/** Child-agent session ids linked to one visible parent. Candidates come from
 * metadata only (the summary rows and the agent-worker links — no folder
 * scan); each candidate's own record is then read strictly and must still be
 * an agent-owned record linked to this parent, so a stale/foreign metadata row
 * can never name a deletion target. */
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
    const session = storedSessionSync(dir, candidateId, false);
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

const ABSENT = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';

// The legacy json's verdict for a delete: 'absent', 'ours', 'damaged' (no
// data, or not JSON at all: kept as `<file>.corrupt-<ts>`, never somebody's
// session) or 'foreign' (valid JSON that is not this session's: never
// deleted). Throws when it cannot be read.
function _jsonVerdict(id, jsonPath) {
  let raw;
  try {
    raw = readFileSync(jsonPath, 'utf-8');
  } catch (err) {
    if (ABSENT(err)) return 'absent';
    throw err;
  }
  if (loadLegacySession(raw, id)) return 'ours';
  if (!holdsNoData(raw)) {
    try {
      JSON.parse(raw);
      return 'foreign';
    } catch {
      /* not JSON: damaged */
    }
  }
  return 'damaged';
}

// Which of the session's files may go, read strictly: { files, damaged,
// absent } or null when a file is not this session's (foreign or ambiguous
// bytes are never deleted) or cannot be read.
function _deletionPlan(id) {
  const jsonPath = sessionPath(id);
  const logPath = sessionLogPath(id);
  let outcome;
  let json;
  let jsonSha1 = null;
  try {
    outcome = resolveSessionRecordSync({ jsonPath, logPath, loadLegacy: loadLegacySession, messages: false });
    json = _jsonVerdict(id, jsonPath);
    // A copy read from the json is bound to its sha1 (bindLoadedSession).
    if (json === 'ours') jsonSha1 = sha1Hex(readFileSync(jsonPath));
  } catch {
    return null;
  }
  if (json === 'foreign') return null;
  const logPresent = outcome.kind === 'log' || outcome.kind === 'orphan' || outcome.kind === 'diverged' || outcome.kind === 'log-invalid';
  if ((outcome.kind === 'log' || outcome.kind === 'orphan' || outcome.kind === 'diverged') && outcome.log.sessionId !== id) {
    return null;
  }
  return {
    jsonPath,
    logPath,
    json,
    logPresent,
    damaged: json === 'damaged' || outcome.kind === 'log-invalid',
    absent: outcome.kind === 'absent',
    // What a copy of the session is bound to, for the copies the delete lets create it anew.
    record: { logId: outcome.log?.logId ?? null, jsonSha1 },
  };
}

function _unlinkIfThere(path) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!ABSENT(err)) throw err;
  }
}

// The copies kept aside beside the log (torn, damaged, diverged, invalid).
function _asideCopies(logPath) {
  const dir = dirname(logPath);
  const prefix = `${basename(logPath)}.`;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  return names.filter((name) => name.startsWith(prefix) && !name.endsWith('.tmp')).map((name) => join(dir, name));
}

/**
 * Hard-delete `id`; resolves true once the session is gone (its json, its log
 * and the copies kept aside beside the log). An absent record is a successful
 * (idempotent) delete; false means nothing was deleted: a liveness veto,
 * another process holding the session, a record that is not this session's,
 * or a failed unlink. `options.damagedOnly` deletes only a damaged record.
 */
export async function deleteSession(id, options = {}) {
  if (_runtimeLivenessVeto(id, options)) return false;
  // One operation in the session's order (session-sequence.mjs): it runs once
  // everything accepted before it ended, and owns the session from its claim
  // through its file removal and claim release. Saves, barriers and deletes
  // accepted after it wait behind it and then run on what it actually did.
  return inSessionOrder(id, 'delete', () => _deleteAsWriter(id, options));
}

async function _deleteAsWriter(id, options) {
  // A session another process holds is that process's: deleting it under
  // its writer would only have the next save recreate it.
  let claim;
  try {
    claim = claimSessionWriter(id);
  } catch (error) {
    _recordLifecycleCommitFailure(id, sessionWriterRefusalError({ id, reason: 'unclaimable', cause: error }), 'delete');
    return false;
  }
  if (!claim.held) {
    const err = sessionWriterRefusalError({ id, reason: 'claimed', path: claim.path });
    err.message = `${err.message} — refusing to delete it`;
    process.stderr.write(`[session-store] ${err.message}\n`);
    _recordLifecycleCommitFailure(id, err, 'delete');
    return false;
  }
  const deleted = await _deleteSession(id, options);
  if (deleted) await forgetSessionWriter(id);
  else if (claim.fresh) await releaseSessionWriter(id);
  return deleted;
}

async function _deleteSession(id, options) {
  const plan = _deletionPlan(id);
  if (!plan) return false;
  if (options.damagedOnly === true && !plan.damaged && !plan.absent) return false;
  // What this process already accepted lands first (later saves wait behind
  // this delete): a rewrite in flight would otherwise rename a file back over
  // the removed log. Nothing is discarded or cancelled before the files are
  // gone (v1.4.5 order): a delete that fails leaves the recorder, its
  // position, the live copy and the debounced copy exactly as they were.
  await settleRecorder(id);
  try {
    // The copies kept aside first, then the json: a delete cut short leaves
    // at most the log, which reads as the session (orphan), never an older
    // legacy copy of it.
    for (const path of _asideCopies(plan.logPath)) _unlinkIfThere(path);
    if (plan.json === 'damaged') await renameWithRetry(plan.jsonPath, quarantinePath(plan.jsonPath));
    else if (plan.json === 'ours') _unlinkIfThere(plan.jsonPath);
    if (plan.logPresent) _unlinkIfThere(plan.logPath);
  } catch {
    return false;
  }
  // Removed: only now does what this process holds of it go — the debounced
  // copy is cancelled and the recorder's queue discarded.
  takePendingWrite(id);
  await forgetDeletedRecorder(id, plan.record);
  // An explicit user delete also fences the id: a still-running turn's later
  // saves would otherwise create the record again.
  if (options.fenceWrites === true) fenceSessionWrites(id);
  _runSessionPurgeHooks(id, { cwds: knownSessionCwds(id) });
  // The display-only compaction archive has no meaning without its session.
  deleteCompactionArchive(getStoreDir(), id);
  // The session's scratch directory (shell TEMP/TMP/TMPDIR) goes with it.
  try {
    removeSessionScratchDir(id);
  } catch {
    /* a locked scratch file never fails the delete */
  }
  _clearLiveSession(id);
  forgetSessionLoadCache(id);
  _clearSessionSaveState(id);
  clearSessionLifecycleCommitError(id);
  // deferSummaryUpdate: bulk callers (tombstone sweep) batch the index update.
  if (options.deferSummaryUpdate === true) _uncacheSessionSummary(id);
  else _queueSessionSummaryRemoval(id);
  return true;
}
