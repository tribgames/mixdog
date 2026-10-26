// Group rooms, membership (agent-rooms.ts). Membership belongs to the agent's
// existence: a bot proven deleted leaves every room it was in, in the
// operation that finds out. A restored bot does not rejoin (`update` adds it
// back by hand); a room keeps its id and log however few members remain.
import { roomMemberSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { MIXY_AGENT_ID } from '../shared/agent-contacts';
import type { createRoomRecords } from './agent-room-records';
import type { RoomScheduler } from './agent-room-scheduler';
import type { AgentRoomDeps, AgentRoomRecord } from './agent-rooms';

type RoomRecords = ReturnType<typeof createRoomRecords>;

/** What membership reads from the host. */
export interface RoomMembershipHost {
  deps: Pick<AgentRoomDeps, 'deleteSession' | 'agentPresence' | 'republishCatalog'>;
  rooms: RoomRecords['rooms'];
  persist: RoomRecords['persist'];
  cancelOwedTo: RoomScheduler['cancelOwedTo'];
  log(line: string): void;
}

export function createRoomMembership({ deps, rooms, persist, cancelOwedTo, log }: RoomMembershipHost) {
  /** `gone` out of `room`'s members and everything kept for them (owed turns,
   *  cursors, seen rows, calls waiting on them). The members array stays the
   *  same array: an exchange in flight holds it as its roster. */
  function removeFromRoom(room: AgentRoomRecord, gone: ReadonlySet<string>): void {
    room.members.splice(0, room.members.length, ...room.members.filter((id) => !gone.has(id)));
    if (room.owed) room.owed = room.owed.filter((id) => !gone.has(id));
    for (const id of gone) {
      delete room.cursors[id];
      if (room.seen) delete room.seen[id];
    }
    cancelOwedTo(room.id, gone);
  }

  /** `agentIds` out of every room's members; Mixy is never removed. Who left
   *  which room. */
  function dropMembers(agentIds: readonly string[]): Array<{ roomId: string; agentId: string }> {
    const ids = new Set(agentIds.filter((id) => id !== MIXY_AGENT_ID));
    const left: Array<{ roomId: string; agentId: string }> = [];
    for (const room of Object.values(rooms())) {
      const gone = new Set(room.members.filter((id) => ids.has(id)));
      if (!gone.size) continue;
      removeFromRoom(room, gone);
      for (const agentId of gone) left.push({ roomId: room.id, agentId });
    }
    return left;
  }

  /** Each of `sessionIds` deleted, whatever happens to the others; how many
   *  could not be. */
  async function deleteSessions(sessionIds: string[]): Promise<number> {
    let failed = 0;
    for (const id of sessionIds) await deps.deleteSession(id).catch(() => (failed += 1));
    return failed;
  }

  const memberSessionsOf = (left: Array<{ roomId: string; agentId: string }>) =>
    left.map(({ roomId, agentId }) => roomMemberSessionId(roomId, agentId));

  /** Once, as the rooms load: members whose definition is proven deleted
   *  (`agentDefinitionPresence`; an unknown or failed check proves nothing)
   *  leave, and the rooms are saved. */
  async function pruneDeleted(): Promise<void> {
    const ids = [...new Set(Object.values(rooms()).flatMap((room) => room.members))];
    if (!deps.agentPresence || !ids.some((id) => id !== MIXY_AGENT_ID)) return;
    const presence = (await deps.agentPresence(ids).catch(() => null)) as Record<string, unknown> | null;
    if (!presence || typeof presence !== 'object') return;
    const left = dropMembers(ids.filter((id) => presence[id] === 'deleted'));
    if (!left.length) return;
    await persist();
    deps.republishCatalog();
    // Load must not fail on a conversation that stays behind: it is logged.
    const failed = await deleteSessions(memberSessionsOf(left));
    if (failed) log(`${failed} conversations of members who left their rooms could not be deleted`);
  }

  return { removeFromRoom, dropMembers, deleteSessions, memberSessionsOf, pruneDeleted };
}
