// How group rooms show in the views (agent-rooms.ts owns the records): the
// room log while members speak, a room's list summary, and the session
// catalog with every room's log stamped.
import {
  roomIdOfSession,
  roomMemberOfSession,
  roomSessionId,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { DesktopAgentRoomSummary, DesktopSessionSummary, SessionSnapshot } from '../shared/contract';
import type { RunState } from './agent-room-turn';
import type { AgentRoomRecord } from './agent-rooms';

/** The room log as its views see it: busy while members speak (so the
 *  composer offers stop), the speaking member's pending approval, and a
 *  typing row naming who is speaking. */
export function decorateRoomSnapshot(
  state: Pick<RunState, 'speaking' | 'speakingName' | 'typingId' | 'approval'> | undefined,
  snapshot: SessionSnapshot
): SessionSnapshot {
  if (!state || !snapshot || typeof snapshot !== 'object') return snapshot;
  const typing = state.speaking
    ? [
        {
          kind: 'notice',
          id: state.typingId,
          tone: 'info',
          text: `${state.speakingName}…`,
          room: {
            kind: 'typing',
            speaker: state.speaking,
            name: state.speakingName,
          },
        },
      ]
    : [];
  return {
    ...snapshot,
    busy: true,
    ...(state.approval ? { toolApproval: state.approval } : {}),
    items: [...(snapshot.items ?? []), ...typing],
  } as SessionSnapshot;
}

export function roomSummary(
  room: AgentRoomRecord,
  names: ReadonlyMap<string, string>,
  running: boolean
): DesktopAgentRoomSummary {
  return {
    id: room.id,
    name: room.name,
    members: [...room.members],
    maxRounds: room.maxRounds,
    maxMessages: room.maxMessages,
    shareTools: room.shareTools,
    ...(room.lastSpeaker ? { lastSpeaker: room.lastSpeaker } : {}),
    ...(room.lastPreview ? { lastPreview: room.lastPreview } : {}),
    memberNames: Object.fromEntries(room.members.map((id) => [id, names.get(id) ?? id])),
    ...(running ? { running: true } : {}),
  };
}

/** The session catalog with every room's log stamped (a room whose log has
 *  no catalog row yet gets one) and member sessions left out. */
export function catalogWithRooms(
  rows: DesktopSessionSummary[],
  rooms: Record<string, AgentRoomRecord>,
  summaryOf: (room: AgentRoomRecord) => DesktopAgentRoomSummary
): DesktopSessionSummary[] {
  const listed = new Set<string>();
  const stamped = rows.flatMap((row) => {
    if (roomMemberOfSession(row.id)) return [];
    const roomId = roomIdOfSession(row.id);
    const room = roomId ? rooms[roomId] : undefined;
    if (!room) return roomId ? [] : [row];
    listed.add(roomId);
    // The log's own catalog time stays at its last save; the room's latest
    // speech (`lastAt`) is what the list shows, as a bot row shows its last chat.
    const lastAt = Math.max(room.lastAt ?? 0, Number(row.activityAt) || 0, row.updatedAt || 0);
    return [{ ...row, title: room.name, updatedAt: lastAt, activityAt: lastAt, agentRoom: summaryOf(room) }];
  });
  const unlisted = Object.values(rooms)
    .filter((room) => !listed.has(room.id))
    .map(
      (room): DesktopSessionSummary => ({
        id: roomSessionId(room.id),
        preview: '',
        title: room.name,
        updatedAt: room.lastAt ?? room.createdAt,
        activityAt: room.lastAt ?? room.createdAt,
        messageCount: 0,
        cwd: '',
        classification: 'task',
        projectPath: null,
        agentRoom: summaryOf(room),
      })
    );
  return [...unlisted, ...stamped];
}
