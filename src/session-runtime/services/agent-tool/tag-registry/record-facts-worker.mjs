// Worker thread: reads one stored session record and answers the few fields a
// reaped-tag resume decides on, so a transcript of several MB is never read or
// parsed on the host's event loop. Same strict parse as the store's lifecycle
// authority: an absent, unreadable, ambiguous or foreign record answers null.
import { readFile } from 'node:fs/promises';
import { serveWorkerRequests } from '../../../../runtime/shared/worker-requests.mjs';
import {
  isLifecycleUnreadable,
  readTopLevelLifecycleRecord,
} from '../../../../runtime/agent/orchestrator/session/lifecycle-scan.mjs';

serveWorkerRequests(async ({ path, sessionId }) => {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  const record = readTopLevelLifecycleRecord(text);
  if (isLifecycleUnreadable(record) || record.id !== sessionId) return null;
  const doc = record.doc;
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
