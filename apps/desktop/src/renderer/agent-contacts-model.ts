import { agentIdOfHomeSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import { type AgentAvatarValue, agentAvatar } from '../shared/core-src/runtime/shared/agent-avatar.mjs';
import { plainPreviewText } from '../shared/core-src/runtime/shared/plain-preview.mjs';
import { MIXY_AGENT_ID, agentRowName, contactAgentRows } from '../shared/agent-contacts';
import type { DesktopSessionSummary } from '../shared/contract';
import { unseenIncomingCount } from '../shared/incoming-tail';
import type { AgentActivityNode } from './agent-activity-model';
import { type AgentChatIndicator, agentGroupIndicator } from './agent-chat-summary';
import { t } from './i18n';
import { mixyAvatar, mixyName } from './mixy-identity';
import { localizedRoutinePreview } from './routine-notice';

export interface AgentContact {
  agentId: string;
  name: string;
  mixy: boolean;
  /** The face it shows: its own pick (mascot or image), else a mascot fixed by its id. */
  avatar: AgentAvatarValue;
  /** The home thread, once it holds a conversation. */
  session: DesktopSessionSummary | null;
  preview: string;
  at: number;
  indicator: AgentChatIndicator;
  /** The home thread holds an unread reply, whatever status the badge shows
   *  (running/attention/error take the badge, not the unread mark). */
  unread: boolean;
  /** How many of the bot's sessions wait on the user's approval: its task
   *  sessions (taskAgent), else its home thread (a home wait beside waiting
   *  task sessions is their docked copy). Sessions it sent work to are
   *  not in the list's data, so they are not counted. At least 1 while the
   *  indicator is attention, unless every wait is a question (`asking`). */
  approvals: number;
  /** Everything the bot waits on is a question for the user, not an approval. */
  asking: boolean;
  /** The bot is switched off (listed only where `includeDisabled` asks). */
  disabled: boolean;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function contactIndicator(
  agentId: string,
  session: DesktopSessionSummary | null,
  tasks: readonly DesktopSessionSummary[],
  nodes: readonly AgentActivityNode[] | undefined,
  unreadSessionIds: ReadonlySet<string> | undefined,
  needsUser: ReadonlySet<string> | undefined
): AgentChatIndicator {
  // The home thread's own turn or one of its tasks waits on the user (an
  // approval or a question): no pool row carries that, and it outranks the
  // running turn it is part of.
  if ([session, ...tasks].some((row) => row && needsUser?.has(row.id))) return { kind: 'attention' };
  const pooled = session && nodes?.length ? agentGroupIndicator(session.id, nodes, unreadSessionIds) : null;
  if (pooled && pooled.kind !== 'unread') return pooled;
  const handedWork = (task: DesktopSessionSummary) =>
    task.working === true && task.handedBy?.includes(agentId) === true;
  if (session?.working || tasks.some(handedWork)) return { kind: 'running' };
  if (!session || !unreadSessionIds?.has(session.id)) return null;
  // The chat messages that arrived since the read cursor, a whole number of at
  // least 1; the row caps how it shows it.
  return { kind: 'unread', count: unseenIncomingCount(session) };
}

/** Each live agent's home thread, and its task sessions in catalog order. Each
 *  bucket is allocated once and appended to. */
export function bucketSessions(sessions: readonly DesktopSessionSummary[]) {
  const homes = new Map<string, DesktopSessionSummary>();
  const tasks = new Map<string, DesktopSessionSummary[]>();
  for (const session of sessions) {
    if (session.archived) continue;
    if (session.agentHome) homes.set(session.agentHome, session);
    if (!session.taskAgent) continue;
    const bucket = tasks.get(session.taskAgent);
    if (bucket) bucket.push(session);
    else tasks.set(session.taskAgent, [session]);
  }
  return { homes, tasks };
}

function contactPreview(
  indicator: AgentChatIndicator,
  session: DesktopSessionSummary | null,
  fallback: string,
  mixy: boolean,
  disabled: boolean,
  asking: boolean
) {
  if (disabled) return t('Off');
  if (indicator?.kind === 'attention') return asking ? t('Answer needed') : t('Waiting for approval');
  if (indicator?.kind === 'running') return t('Working');
  const shown =
    plainPreviewText(
      localizedRoutinePreview(text(session?.lastMessagePreview), session?.lastMessageRoutine) || text(session?.preview)
    ) || plainPreviewText(fallback);
  return shown || (mixy ? '' : t('No messages yet'));
}

function contactApprovals(
  session: DesktopSessionSummary | null,
  tasks: readonly DesktopSessionSummary[],
  indicator: AgentChatIndicator,
  needsUser: ReadonlySet<string> | undefined,
  asking: ReadonlySet<string> | undefined
): { asking: boolean; approvals: number } {
  const waiting = [session, ...tasks].filter((row): row is DesktopSessionSummary =>
    Boolean(row && needsUser?.has(row.id))
  );
  const approvalIds = waiting.map((row) => row.id).filter((id) => !asking?.has(id));
  const taskApprovals = approvalIds.filter((id) => id !== session?.id).length;
  const approvalRows = taskApprovals > 0 ? taskApprovals : approvalIds.length;
  const questionOnly = indicator?.kind === 'attention' && waiting.length > 0 && approvalRows === 0;
  return {
    asking: questionOnly,
    approvals: indicator?.kind === 'attention' && !questionOnly ? Math.max(1, approvalRows) : 0,
  };
}

/** Contacts in list order. `groups` are the pool's Lead groups by owner id;
 *  `needsUser` the sessions waiting on the user (useSessionAttentionIndex).
 *  Switched-off bots are left out unless `includeDisabled` (the 봇 page). */
export function agentContacts(
  agents: unknown,
  sessions: readonly DesktopSessionSummary[],
  groups: ReadonlyMap<string, readonly AgentActivityNode[]>,
  unreadSessionIds?: ReadonlySet<string>,
  {
    includeDisabled = false,
    needsUser,
    asking,
  }: { includeDisabled?: boolean; needsUser?: ReadonlySet<string>; asking?: ReadonlySet<string> } = {}
): AgentContact[] {
  const { homes, tasks } = bucketSessions(sessions);
  const contact = (
    agentId: string,
    name: string,
    storedAvatar: unknown,
    description: string,
    mixy: boolean,
    disabled = false
  ): AgentContact => {
    const session = homes.get(agentId) ?? null;
    const agentTasks = tasks.get(agentId) ?? [];
    const indicator = contactIndicator(
      agentId,
      session,
      agentTasks,
      session ? groups.get(session.id) : undefined,
      unreadSessionIds,
      needsUser
    );
    const waits = contactApprovals(session, agentTasks, indicator, needsUser, asking);
    return {
      agentId,
      name,
      mixy,
      ...waits,
      avatar: agentAvatar(agentId, storedAvatar),
      session,
      preview: contactPreview(indicator, session, description, mixy, disabled, waits.asking),
      at: session ? Number(session.activityAt) || session.updatedAt : 0,
      indicator,
      unread: session ? unreadSessionIds?.has(session.id) === true : false,
      disabled,
    };
  };
  return [
    contact(MIXY_AGENT_ID, mixyName(), mixyAvatar(), '', true),
    ...contactAgentRows(agents, { includeDisabled }).map((row) =>
      contact(row.id, agentDisplayName(row), row.avatar, text(row.description), false, row.disabled === true)
    ),
  ];
}

function agentDisplayName(row: { id: string; label?: unknown; definition?: unknown }): string {
  return agentRowName(row) || row.id;
}

/** A home thread's tab title: its agent's name, never a title from the
 *  thread's first prompt; null for every other session. Before the catalog
 *  has the agent, its id stands in. */
export function agentHomeTitle(sessionId: string, agents: unknown): string | null {
  const agentId = agentIdOfHomeSession(sessionId);
  if (!agentId) return null;
  if (agentId === MIXY_AGENT_ID) return mixyName();
  const row = Array.isArray(agents)
    ? (agents as Array<{ id?: unknown }>).find((entry) => entry && entry.id === agentId)
    : undefined;
  return row ? agentDisplayName({ ...row, id: agentId }) : agentId;
}
