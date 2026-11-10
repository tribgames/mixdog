// session/human-gate/session-life.mjs
// The life a session is in right now, as a mark: a session grant made under
// another mark (the session was cleared since, or it is a newer session of the
// same fixed id) no longer counts. null when the session is unknown or closed.
import { loadSession } from '../store/load-session.mjs';

export function sessionLifeMark(sessionId) {
  try {
    const session = sessionId ? loadSession(sessionId) : null;
    if (!session || session.closed === true) return null;
    return `${session.createdAt ?? 0}:${session.compaction?.lastClearAt ?? 0}`;
  } catch {
    return null;
  }
}
