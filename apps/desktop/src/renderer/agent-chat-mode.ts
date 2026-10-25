// Agent mode (에이전트 모드): a Lead made as an agent — an agent's home thread
// or a group room — reads as a messenger chat instead of a coding task: no
// tabs, a contact header, bubbles and a one-line composer. Coding sessions
// never take any of it. ONE helper decides which sessions it is: the
// session's persisted mode (`sessionMode: 'agent'`, session/agent-mode.mjs)
// when the catalog carries it, else the reserved home / room ids. The bubble
// runs live in agent-chat-place.ts.
import { useSyncExternalStore } from 'react';
import {
  agentIdOfHomeSession,
  isAgentHomeSessionId,
} from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { loadArchivedBotIdentities } from './archived-bot-identity';
import { roomIdOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { DesktopSessionSummary } from '../shared/contract';

let flagged: ReadonlySet<string> = new Set();
let deletedHomes: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const sameIds = (ids: readonly string[], set: ReadonlySet<string>) =>
  ids.length === set.size && ids.every((id) => set.has(id));

/** Take the persisted modes, and the deleted bots' homes, of a fresh session catalog. */
export function publishAgentModeSessions(
  sessions: readonly Pick<DesktopSessionSummary, 'id' | 'sessionMode' | 'agentDeleted'>[]
): void {
  const next = sessions.filter((session) => session.sessionMode === 'agent').map((session) => session.id);
  const deleted = sessions.filter((session) => session.agentDeleted === true).map((session) => session.id);
  if (sameIds(next, flagged) && sameIds(deleted, deletedHomes)) return;
  flagged = new Set(next);
  deletedHomes = new Set(deleted);
  // Their archived chats show the name and face the bot left.
  loadArchivedBotIdentities(deleted.map((id) => agentIdOfHomeSession(id)).filter(Boolean));
  for (const listener of [...listeners]) listener();
}

/** The durable cache's modes for the first paint, taken only while nothing
 *  reads the store (seedAgentRooms in agent-room-store.ts says why). */
export function seedAgentModeSessions(
  sessions: readonly Pick<DesktopSessionSummary, 'id' | 'sessionMode' | 'agentDeleted'>[]
): void {
  if (listeners.size === 0) publishAgentModeSessions(sessions);
}

/** Whether `sessionId` is the home thread of a deleted bot: kept to read, never to send. */
export function isDeletedBotSession(sessionId: string | null | undefined): boolean {
  return deletedHomes.has(String(sessionId || ''));
}

export function useDeletedBotSession(sessionId: string | null | undefined): boolean {
  const read = () => isDeletedBotSession(sessionId);
  return useSyncExternalStore(subscribe, read, read);
}

/** Whether `sessionId` is an agent-mode chat (home thread or group room). */
export function isAgentChatSession(sessionId: string | null | undefined): boolean {
  const id = String(sessionId || '');
  if (!id) return false;
  return flagged.has(id) || isAgentHomeSessionId(id) || Boolean(roomIdOfSession(id));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentChatSession(sessionId: string | null | undefined): boolean {
  const read = () => isAgentChatSession(sessionId);
  return useSyncExternalStore(subscribe, read, read);
}
