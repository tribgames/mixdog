// Worker thread: reads one stored session record and answers the few fields a
// reaped-tag resume decides on, so a transcript of several MB is never read or
// parsed on the host's event loop. Same strict parse as the store's lifecycle
// authority: an absent, unreadable, ambiguous or foreign record answers null.
// `path` is the session's legacy record path; the record (its log, else that
// json) is resolved through the record seam, a header scan of the log.
import { serveWorkerRequests } from '../../../../runtime/shared/worker-requests.mjs';
import {
  isAbsentReadError,
  loadLegacySession,
  recordSession,
  sessionRecordFilesOf,
} from '../../../../runtime/agent/orchestrator/session/store/session-record.mjs';
import { resolveSessionRecord } from '../../../../runtime/agent/orchestrator/session/store/session-log-reader.mjs';

serveWorkerRequests(async ({ path, sessionId }) => {
  let outcome;
  try {
    outcome = await resolveSessionRecord({ ...sessionRecordFilesOf(path), loadLegacy: loadLegacySession, messages: false });
  } catch (error) {
    if (isAbsentReadError(error)) return null;
    throw error;
  }
  const doc = recordSession(outcome, sessionId);
  if (!doc) return null;
  return {
    id: sessionId,
    agentTag: doc.agentTag || null,
    agent: doc.agent || null,
    parentSessionId: doc.parentSessionId || null,
    ownerSessionId: doc.ownerSessionId || null,
    clientHostPid: doc.clientHostPid || null,
    cwd: doc.cwd || '',
    closed: doc.closed === true || doc.status === 'closed',
    lastTurnCompletedAt: doc.lastTurnCompletedAt ?? null,
    ownerClosedAt: doc.ownerClosedAt ?? null,
    closeProvenance: doc.closeProvenance ?? null,
  };
});
