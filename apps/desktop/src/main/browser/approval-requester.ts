import { agentHomeSessionId } from '../../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import {
  MIXY_AGENT_ID,
  MIXY_DEFAULT_NAME,
  type AgentCatalogRow,
  agentRowName,
  contactAgentRows,
} from '../../shared/agent-contacts';
import { type SessionTitleLabels, sessionTitleLabel } from '../../shared/session-title.mjs';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../../shared/contract';

/** `name`: who is asking, for the card ('' when the session is unknown).
 *  `agentId`: the bot whose own chat asked ('' for a coding session, a room, a
 *  schedule or an agent that is no bot): the only one a standing allow may be
 *  recorded for or read from. A sub-agent (any depth) asks as the root bot
 *  of the chat its work surfaces in. */
export interface ApprovalRequester {
  name: string;
  agentId: string;
  /** The asking session's working directory, when known. */
  cwd?: string;
  /** false: the step may run on `agentId`'s standing allows, but the card
   *  must not offer "always allow" — delegated work (a sub-agent, a task
   *  session) is not answered in the bot's own chat. Absent: as `agentId`. */
  rememberable?: boolean;
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

/** The top-level chat a session's approvals surface in: a task session a bot
 *  created in its own chat (and its sub-agents) → that chat; a sub-agent of
 *  any other session → that session; anything else itself. The approval
 *  notification opens it. */
export function approvalSurfaceSessionId(sessionId: string, sources: RequesterSources): string {
  const found = topSessionOf(sessionId, sources);
  if (!found) return sessionId;
  const home = found.top.taskFrom === 'home' && found.top.taskAgent ? agentHomeSessionId(found.top.taskAgent) : '';
  return home && sources.sessions().some((entry) => entry.id === home) ? home : found.top.id;
}

/** A listed bot's catalog name (its rename included); '' when `agentId` is no
 *  bot. Mixy is never a catalog contact: it is named by its identity
 *  (`getLeadStatus` name, passed as `leadName`), else the default. */
export function agentHomeName(agents: unknown, agentId: string, leadName = ''): string {
  if (agentId === MIXY_AGENT_ID) return leadName.trim() || MIXY_DEFAULT_NAME;
  const row = contactAgentRows(agents).find((agent) => agent.id === agentId);
  return row ? agentRowName(row) : '';
}

/** Who is asking: a bot's home chat is that bot (its catalog name), any other
 *  session is named by its title and belongs to no bot. A sub-agent or a
 *  bot's task session is named by its chain ("사무관 › Worker", "사무관 ›
 *  Task session", "Lead › Reviewer") and belongs to the bot whose own chat it
 *  works under. */
export function createApprovalRequesterResolver(
  deps: RequesterSources & {
    listAgents(): Promise<unknown>;
    titleLabels?(): SessionTitleLabels;
    /** "Lead" in this PC's language: a coding Lead's place in a chain. */
    leadName?(): string;
    /** "Task session" in this PC's language: a bot's task session in a chain. */
    taskName?(): string;
  }
): (sessionId: string) => Promise<ApprovalRequester> {
  const ownRequester = async (session: DesktopSessionSummary, agents: unknown): Promise<ApprovalRequester> => {
    const title = sessionTitleLabel(session.title || session.preview, deps.titleLabels?.());
    const cwd = session.cwd ? { cwd: session.cwd } : {};
    const home = session.agentHome || '';
    if (!home) return { name: title, agentId: '', ...cwd };
    if (home === MIXY_AGENT_ID) return { name: title, agentId: home, ...cwd };
    const name = agentHomeName(await agents, home);
    return name ? { name, agentId: home, ...cwd } : { name: title, agentId: '', ...cwd };
  };
  return async (sessionId) => {
    const agents = deps.listAgents().catch(() => []);
    const found = topSessionOf(sessionId, deps);
    if (!found) return { name: '', agentId: '' };
    const { top, chain } = found;
    if (!chain.length && !top.taskAgent) return ownRequester(top, agents);
    const catalog = await agents;
    const agentName = (row: DesktopAgentPoolRow) => {
      const id = text(row.agent);
      const entry = Array.isArray(catalog)
        ? (catalog as AgentCatalogRow[]).find((agent) => agent && text(agent.id) === id)
        : undefined;
      return entry ? agentRowName(entry) : id || text(row.tag);
    };
    const cwdOf = chain.length ? text(chain[0].cwd) : text(top.cwd);
    const cwd = cwdOf ? { cwd: cwdOf } : {};
    const below = chain.map(agentName).reverse();
    if (top.taskAgent) {
      // A task session a bot created, or its sub-agent: named under the bot.
      // It acts as the bot only when the bot's own chat created it — never a
      // room, a run, or a task whose origin was not recorded.
      const bot = contactAgentRows(catalog).find((agent) => agent.id === top.taskAgent);
      const head = bot ? agentRowName(bot) : top.taskAgent;
      const agentId = bot && top.taskFrom === 'home' ? bot.id : '';
      const name = [head, deps.taskName?.() || 'Task session', ...below].join(' › ');
      return { name, agentId, rememberable: false, ...cwd };
    }
    const own = await ownRequester(top, catalog);
    const head = top.agentHome ? own.name : deps.leadName?.() || 'Lead';
    return { name: [head, ...below].join(' › '), agentId: own.agentId, rememberable: false, ...cwd };
  };
}
