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

/** A pending ask_user question of a session a room member handed work to, as
 *  the room shows it: the member's copy (tui/session/tool-approval.mjs
 *  `handoffQuestions`), named by that member and its session. */
export type RoomHandoffQuestion = Record<string, unknown> & {
  id: string;
  /** The member that handed the work; its card sits under its words. */
  roomMember: string;
  /** The member's own session, the one its copy is answered through. */
  memberSessionId: string;
};

/** Per room, the handed-off questions its members' catalog rows carry (the
 *  daemon's session-action.mjs `handoffQuestions`), each tagged with its
 *  member. A room whose list is unchanged keeps the array of `previous`: the
 *  room snapshot's `handoffQuestions` identity is what its views re-render on. */
export function roomHandoffQuestionsOf(
  rows: ReadonlyArray<Record<string, unknown>>,
  previous: ReadonlyMap<string, RoomHandoffQuestion[]>
): Map<string, RoomHandoffQuestion[]> {
  const next = new Map<string, RoomHandoffQuestion[]>();
  for (const row of rows) {
    const memberSessionId = String(row.id || '');
    const member = roomMemberOfSession(memberSessionId);
    const asked = row.handoffQuestions;
    if (!member || !Array.isArray(asked) || !asked.length) continue;
    const tagged = asked.flatMap((question) =>
      question && typeof question === 'object' && (question as { id?: unknown }).id
        ? [
            {
              ...(question as Record<string, unknown>),
              id: String((question as { id: unknown }).id),
              roomMember: member.agentId,
              memberSessionId,
            },
          ]
        : []
    );
    next.set(member.roomId, [...(next.get(member.roomId) ?? []), ...tagged]);
  }
  for (const [roomId, questions] of next) {
    const before = previous.get(roomId);
    if (before && JSON.stringify(before) === JSON.stringify(questions)) next.set(roomId, before);
  }
  return next;
}

/** The room log as its views see it: busy while members speak (so the
 *  composer offers stop), the speaking member's pending approval, a typing
 *  row naming who is speaking, and the questions of sessions its members
 *  handed work to, while they wait, whether or not anyone speaks. */
export function decorateRoomSnapshot(
  state: Pick<RunState, 'speaking' | 'speakingName' | 'typingId' | 'approval'> | undefined,
  snapshot: SessionSnapshot,
  handoffQuestions: readonly RoomHandoffQuestion[] = []
): SessionSnapshot {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const asked = handoffQuestions.length ? { handoffQuestions } : {};
  if (!state) return handoffQuestions.length ? ({ ...snapshot, ...asked } as SessionSnapshot) : snapshot;
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
    ...asked,
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
    // The room's latest message (`lastAt`) is what the list shows. The log
    // session's own catalog time moves whenever it is loaded, saved or disposed
    // (a room opened, a member reading it), so it is only the fallback for a
    // room that has no `lastAt` yet.
    const lastAt = room.lastAt ?? Math.max(Number(row.activityAt) || 0, row.updatedAt || 0);
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
