// Bot-owned work: the live work in a session that a bot sent. A bot's accepted
// `session` send or create (session-runtime/agent-task-sessions.mjs) is the
// bot's work in that session from its acceptance until it settles or is
// cancelled — whether or not it reports back (`notify: false`, a report watch
// that could not be stored). A turn nobody sent (the user typed it in the
// task session) is owned by no bot, so it never reads as a bot being busy.
// Process-wide and dependency-free like delegated-approval-host.mjs. The
// registry is only this process's cache: what keeps the work owned across a
// restart is stored apart (a reporting send's watch, any other send's record
// of its work, both in agent-home-delivery.mjs) and re-noted by
// agent-task-sessions.mjs recover. A change of which bots own a session's work
// is announced (session-activity-signal.mjs onSessionBotWorkChange), so the
// session catalog, which stamps them on each row, re-lists.
import { emitSessionBotWorkChange } from './session-activity-signal.mjs';

const KEY = Symbol.for('mixdog.botOwnedWork.v1');

/** Map run id → `{ sessionId, agentId }`. */
function registry() {
  globalThis[KEY] ??= new Map();
  return globalThis[KEY];
}

/** How many owned works of `agentId` run in `sessionId`. */
function worksOf(sessionId, agentId) {
  let count = 0;
  for (const work of registry().values()) if (work.sessionId === sessionId && work.agentId === agentId) count += 1;
  return count;
}

/** Every session with owned work and the bots owning it (each once, in noting
 *  order): Map session → agent ids. */
export function botWorkBySession() {
  const bySession = new Map();
  for (const { sessionId, agentId } of registry().values()) {
    const agents = bySession.get(sessionId) ?? [];
    if (!agents.includes(agentId)) agents.push(agentId);
    bySession.set(sessionId, agents);
  }
  return bySession;
}

/** Agent `agentId`'s submission `runId` to `sessionId` was accepted. */
export function noteBotWork({ runId, sessionId, agentId }) {
  if (!runId || !sessionId || !agentId || registry().has(String(runId))) return;
  registry().set(String(runId), { sessionId: String(sessionId), agentId: String(agentId) });
  if (worksOf(String(sessionId), String(agentId)) === 1) emitSessionBotWorkChange(sessionId);
}

/** Submission `runId` settled or was cancelled: its work is nobody's now. */
export function endBotWork(runId) {
  const work = registry().get(String(runId));
  if (!work) return;
  registry().delete(String(runId));
  if (worksOf(work.sessionId, work.agentId) === 0) emitSessionBotWorkChange(work.sessionId);
}
