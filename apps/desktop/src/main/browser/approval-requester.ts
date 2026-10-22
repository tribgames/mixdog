import { agentIdOfHomeSession } from '../../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import {
  roomMemberOfSession,
  roomSessionId,
} from '../../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import {
  MIXY_AGENT_ID,
  MIXY_DEFAULT_NAME,
  type AgentCatalogRow,
  agentRowName,
  contactAgentRows,
} from '../../shared/agent-contacts';
import { type SessionTitleLabels, sessionTitleLabel } from '../../shared/session-title.mjs';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../../shared/contract';

/** `name`: who is asking, for the card ('' when the session is unknown). */
export interface ApprovalRequester {
  name: string;
  /** The asking session's working directory, when known. */
  cwd?: string;
}

/** The bot whose OWN session `sessionId` is: its 1:1 home chat or its room
 *  member session; '' for anything else (a coding session, a task session, a
 *  sub-agent at any depth, an unknown id). Read from the id alone, so it never
 *  depends on the agent catalog or on a lookup succeeding. Only this bot asks,
 *  and a standing allow is recorded for / read from it alone. */
export function ownBotOfSession(sessionId: string): string {
  return agentIdOfHomeSession(sessionId) || roomMemberOfSession(sessionId)?.agentId || '';
}

interface RequesterSources {
  sessions(): readonly DesktopSessionSummary[];
  /** The agent pool: a sub-agent session is no catalog row, its pool row
   *  names the top-level session it works for (`ownerSessionId`). */
  agentPool?(): readonly DesktopAgentPoolRow[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The pool rows from `sessionId`'s own up through its spawn parents, nearest
 *  first; [] for a session that is no sub-agent. */
function agentRowChain(sessionId: string, pool: readonly DesktopAgentPoolRow[]): DesktopAgentPoolRow[] {
  const chain: DesktopAgentPoolRow[] = [];
  let id = sessionId;
  while (id && chain.length < 16) {
    const row = pool.find((entry) => entry.sessionId === id);
    if (!row || chain.includes(row)) break;
    chain.push(row);
    id = text(row.parentSessionId);
  }
  return chain;
}

/** The listed session a session's work belongs to: itself, or a sub-agent's
 *  owner; with the sub-agent's pool rows (nearest first, [] for itself). */
function topSessionOf(sessionId: string, sources: RequesterSources) {
  const sessions = sources.sessions();
  const own = sessions.find((entry) => entry.id === sessionId);
  if (own) return { top: own, chain: [] as DesktopAgentPoolRow[] };
  const chain = agentRowChain(sessionId, sources.agentPool?.() ?? []);
  const top = sessions.find((entry) => entry.id === text(chain.at(-1)?.ownerSessionId));
  return top ? { top, chain } : null;
}

/** A group-room member session (unlisted: the catalog leaves members out) a
 *  session is, or works for, with the sub-agent's pool rows (nearest first,
 *  [] for the member itself); null for any other session. */
function roomSeatOf(sessionId: string, sources: RequesterSources) {
  const chain = agentRowChain(sessionId, sources.agentPool?.() ?? []);
  const member = roomMemberOfSession(text(chain.at(-1)?.ownerSessionId) || sessionId);
  return member ? { member, chain } : null;
}

/** The top-level chat a session's approvals surface in: a sub-agent → the
 *  session it works for; a room member (and its sub-agents) → the room's log,
 *  where the room shows its approvals; anything else itself. A task session a
 *  bot created is an ordinary top-level session, so it and its sub-agents
 *  surface in it, never the bot's home. The approval notification opens it. */
export function approvalSurfaceSessionId(sessionId: string, sources: RequesterSources): string {
  const found = topSessionOf(sessionId, sources);
  if (found) return found.top.id;
  const seat = roomSeatOf(sessionId, sources);
  return seat ? roomSessionId(seat.member.roomId) : sessionId;
}

/** A listed bot's catalog name (its rename included); '' when `agentId` is no
 *  bot. Mixy is never a catalog contact: it is named by its identity
 *  (`getLeadStatus` name, passed as `leadName`), else the default. */
export function agentHomeName(agents: unknown, agentId: string, leadName = ''): string {
  if (agentId === MIXY_AGENT_ID) return leadName.trim() || MIXY_DEFAULT_NAME;
  const row = contactAgentRows(agents).find((agent) => agent.id === agentId);
  return row ? agentRowName(row) : '';
}

/** Who is asking: a bot's home chat and its room member session are that bot
 *  (its catalog name), any other session (a task session a bot created
 *  included) is named by its title and belongs to no bot. A sub-agent is named
 *  by its chain ("사무관 › Worker", "Lead › Reviewer") and belongs to no bot. */
export function createApprovalRequesterResolver(
  deps: RequesterSources & {
    listAgents(): Promise<unknown>;
    titleLabels?(): SessionTitleLabels;
    /** "Lead" in this PC's language: a coding Lead's place in a chain. */
    leadName?(): string;
  }
): (sessionId: string) => Promise<ApprovalRequester> {
  const ownRequester = async (session: DesktopSessionSummary, agents: unknown): Promise<ApprovalRequester> => {
    const title = sessionTitleLabel(session.title || session.preview, deps.titleLabels?.());
    const cwd = session.cwd ? { cwd: session.cwd } : {};
    const home = session.agentHome || '';
    if (!home || home === MIXY_AGENT_ID) return { name: title, ...cwd };
    return { name: agentHomeName(await agents, home) || title, ...cwd };
  };
  return async (sessionId) => {
    const agents = deps.listAgents().catch(() => []);
    const found = topSessionOf(sessionId, deps);
    const seat = found ? null : roomSeatOf(sessionId, deps);
    if (!found && !seat) return { name: '' };
    const chain = found?.chain ?? seat?.chain ?? [];
    // A room member is its bot, as in the bot's home chat.
    const seatRequester = async (): Promise<ApprovalRequester> => {
      const agentId = seat?.member.agentId ?? '';
      return { name: agentHomeName(await agents, agentId) || agentId };
    };
    if (!chain.length) return found ? ownRequester(found.top, agents) : seatRequester();
    const catalog = await agents;
    const agentName = (row: DesktopAgentPoolRow) => {
      const id = text(row.agent);
      const entry = Array.isArray(catalog)
        ? (catalog as AgentCatalogRow[]).find((agent) => agent && text(agent.id) === id)
        : undefined;
      return entry ? agentRowName(entry) : id || text(row.tag);
    };
    const cwdOf = text(chain[0].cwd);
    const cwd = cwdOf ? { cwd: cwdOf } : {};
    const below = chain.map(agentName).reverse();
    const own = found ? await ownRequester(found.top, catalog) : await seatRequester();
    const head = !found || found.top.agentHome ? own.name : deps.leadName?.() || 'Lead';
    return { name: [head, ...below].join(' › '), ...cwd };
  };
}
