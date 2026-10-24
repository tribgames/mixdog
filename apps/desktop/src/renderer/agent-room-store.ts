// Group rooms as the session catalog stamps them (DesktopSessionSummary
// .agentRoom), keyed by their log session, for the surfaces that hold no
// catalog of their own: the room panel, the composer and the transcript.
import { useSyncExternalStore } from 'react';
import type { DesktopAgentRoomSummary, DesktopSessionSummary } from '../shared/contract';

let rooms: ReadonlyMap<string, DesktopAgentRoomSummary> = new Map();
let signature = '';
const listeners = new Set<() => void>();

/** Take the rooms of a fresh catalog; listeners hear only real changes. */
export function publishAgentRooms(sessions: readonly DesktopSessionSummary[]): void {
  const next = new Map<string, DesktopAgentRoomSummary>();
  for (const session of sessions) if (session.agentRoom) next.set(session.id, session.agentRoom);
  const nextSignature = JSON.stringify([...next]);
  if (nextSignature === signature) return;
  signature = nextSignature;
  rooms = next;
  for (const listener of [...listeners]) listener();
}

/** A room's name by room id (not its log session), read now. */
export function agentRoomName(roomId: string): string | undefined {
  for (const room of rooms.values()) if (room.id === roomId) return room.name;
  return undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The room whose log is `sessionId`; null for any other session. */
export function useAgentRoom(sessionId: string | null | undefined): DesktopAgentRoomSummary | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? (rooms.get(sessionId) ?? null) : null),
    () => null
  );
}
