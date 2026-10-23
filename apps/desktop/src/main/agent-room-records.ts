// The group rooms' records (agent-rooms.ts drives them): the stored room
// documents, loaded once (a failed read is retried by the next action), and the
// members' display names and labels as the agent catalog gives them.
import { type AgentCatalogRow, MIXY_AGENT_ID, contactAgentRows } from '../shared/agent-contacts';
import type { MemberLabel } from './agent-room-turn';
import type { AgentRoomDeps, AgentRoomRecord, AgentRoomStoreDoc } from './agent-rooms';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A catalog row's display name, as its contact row shows it. */
function agentName(row: { id: string; label?: unknown; definition?: unknown }): string {
  const definition = row.definition && typeof row.definition === 'object' ? row.definition : {};
  return text((definition as { name?: unknown }).name) || text(row.label) || row.id;
}

/** A catalog row's description, '' when it has none (the supervisor prompt
 *  keeps its first line, bounded). */
function agentDescription(row: { description?: unknown; definition?: unknown }): string {
  const definition = row.definition && typeof row.definition === 'object' ? row.definition : {};
  return text(row.description) || text((definition as { description?: unknown }).description);
}

export function createRoomRecords(deps: Pick<AgentRoomDeps, 'store' | 'listAgents' | 'leadName'>) {
  let doc: AgentRoomStoreDoc = { rooms: {} };
  let loaded: Promise<void> | null = null;
  let stored: Promise<void> | null = null;
  /** Agent display names by id, refreshed whenever the agents are listed. */
  const names = new Map<string, string>();

  /** The room records alone: no daemon call. */
  function loadRecords(): Promise<void> {
    // A failed read is not kept: the next room action reads again.
    stored ??= deps.store.load().then(
      (value) => {
        doc = value;
      },
      (error) => {
        stored = null;
        throw error;
      }
    );
    return stored;
  }

  function ready(): Promise<void> {
    loaded ??= loadRecords()
      .then(refreshNames)
      .catch((error) => {
        loaded = null;
        throw error;
      });
    return loaded;
  }

  async function refreshNames(): Promise<void> {
    // Every user-made definition names its member, a bot or not: a member of
    // a 1.3.0 room that is a workflow agent now keeps its name.
    const listed = await deps.listAgents().catch(() => []);
    const rows = Array.isArray(listed)
      ? listed.filter((row): row is AgentCatalogRow & { id: string } => {
          const entry = row as AgentCatalogRow | null;
          return entry?.custom === true && typeof entry.id === 'string' && Boolean(entry.id);
        })
      : [];
    for (const row of rows) names.set(row.id, agentName(row));
    names.set(MIXY_AGENT_ID, await mixyName());
  }
  const mixyName = async () => (await deps.leadName?.().catch(() => '')) || 'Mixy';

  async function memberLabels(room: AgentRoomRecord): Promise<Map<string, MemberLabel>> {
    const rows = contactAgentRows(await deps.listAgents().catch(() => []), { includeDisabled: true });
    const labels = new Map<string, MemberLabel>();
    const lead = room.members.includes(MIXY_AGENT_ID) ? await mixyName() : '';
    for (const id of room.members) {
      const row = rows.find((entry) => entry.id === id);
      const isLead = id === MIXY_AGENT_ID;
      const rowName = row ? agentName(row) : (names.get(id) ?? id);
      const name = isLead ? lead : rowName;
      if (row) names.set(id, name);
      const rowDescription = row ? agentDescription(row) : '';
      const description = isLead ? "The user's main assistant." : rowDescription;
      labels.set(id, { id, name, route: row?.route, description, ...(row?.disabled === true ? { disabled: true } : {}) });
    }
    return labels;
  }

  /** The members that may take a new turn: switched-off bots stay members but never speak. */
  const speakingMembers = (labels: Map<string, MemberLabel>): MemberLabel[] =>
    [...labels.values()].filter((member) => !member.disabled);

  return {
    /** The loaded rooms by id (the live map: changes are saved by `persist`). */
    rooms: (): Record<string, AgentRoomRecord> => doc.rooms,
    names: names as ReadonlyMap<string, string>,
    loadRecords,
    ready,
    refreshNames,
    memberLabels,
    speakingMembers,
    persist: () => deps.store.save(doc),
    roomOf(roomId: string): AgentRoomRecord {
      const room = doc.rooms[roomId];
      if (!room) throw new Error('This room no longer exists.');
      return room;
    },
  };
}
