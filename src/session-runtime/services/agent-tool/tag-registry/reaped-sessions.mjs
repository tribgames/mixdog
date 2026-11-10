// Sessions behind a reaped tag, for an explicit reuse of that tag only (scans
// never read these). A reap drops only the index row and leaves a capped,
// expiring tombstone; the session record stays on disk and still names its
// tag and owner session, and the store's own retention deletes it in time.
// These reads let a send or explicit spawn continue that saved session, or at
// least prove the tag was this owner's, once the index no longer can.
import { sessionPath } from '../../../../runtime/agent/orchestrator/session/store/session-paths.mjs';
import { resumableAfterReap } from '../../../../runtime/shared/agent-reap-state.mjs';
import { createWorkerRequestClient } from '../../../../runtime/shared/worker-requests.mjs';
import {
  agentTagOf,
  callerSessionForContext,
  clean,
  isExistingDirectory,
  sessionMatchesContext,
  stampMs,
} from '../helpers.mjs';
import { isLeadPoolAgent } from '../worker-rows.mjs';

// The record is read and parsed on a worker thread (record-facts-worker.mjs),
// started on the first resume and retired when idle.
const readRecordFacts = createWorkerRequestClient(new URL('./record-facts-worker.mjs', import.meta.url), {
  idleExitMs: 30_000,
});

async function storedRecordFacts(sessionId) {
  let path;
  try {
    path = sessionPath(sessionId);
  } catch {
    return null;
  }
  return readRecordFacts({ path, sessionId });
}

export function createReapedSessions({ mgr, getLiveSession, isReleased }) {
  function ownedTagSession(session, tag, context) {
    return (
      Boolean(clean(session?.id)) &&
      agentTagOf(session) === tag &&
      !isLeadPoolAgent(session.agent) &&
      sessionMatchesContext(session, context)
    );
  }

  /** The newest session record (open or closed) the caller's owner session
   *  ran under `tag`, or null when it never used the tag. Only an owner
   *  session scopes this: a terminal pid alone proves nothing durable. */
  function lastTagSession(tag, context = {}) {
    const value = clean(tag);
    if (!value || value.startsWith('sess_') || !callerSessionForContext(context)) return null;
    let newest = null;
    for (const session of mgr.listSessions?.({ includeClosed: true }) || []) {
      if (!ownedTagSession(session, value, context)) continue;
      if (!newest || stampMs(session.createdAt) > stampMs(newest.createdAt)) newest = session;
    }
    return newest;
  }

  /** Whether `sessionId` may continue under `tag` for this owner, decided by
   *  its stored record (strictly parsed off the event loop; a daemon-owned
   *  child's live descriptor carries none of these fields): still stored, not
   *  closed, carrying close provenance and not closed by its owner since its
   *  last turn (resumableAfterReap; the index's released marker counts only
   *  for its TTL), and naming this tag and owner. `{ session }` when it may
   *  continue, `{ missingCwd }` when only its working directory is gone, else
   *  null. */
  async function resumableTagSession(tag, sessionId, context = {}) {
    const value = clean(tag);
    const id = clean(sessionId);
    if (!value || !id || isReleased(id)) return null;
    const record = await storedRecordFacts(id);
    if (!record || record.closed === true || !resumableAfterReap(record)) return null;
    if (!ownedTagSession(record, value, context)) return null;
    const session = getLiveSession(id);
    if (!session) return null;
    const cwd = clean(record.cwd);
    return (await isExistingDirectory(cwd)) ? { session } : { missingCwd: cwd };
  }

  return { lastTagSession, resumableTagSession };
}
