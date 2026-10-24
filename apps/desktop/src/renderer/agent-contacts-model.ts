// The Agents pane's contacts: Mixy first, then each user-facing agent, every
// one a messenger row over its home thread. Built only from the agent catalog,
// the session catalog (the host stamps each home thread with its agent) and
// the agent pool the pane already reads.
import { agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { type AgentAvatarValue, agentAvatar } from '../../../../src/runtime/shared/agent-avatar.mjs';
import { plainPreviewText } from '../../../../src/runtime/shared/plain-preview.mjs';
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
  /** How many of the bot's sessions wait on the user's approval: its home
   *  thread plus its task sessions (taskAgent). Sessions it sent work to are
   *  not in the list's data, so they are not counted. At least 1 while the
   *  indicator is attention, unless every wait is a question (`asking`). */
  approvals: number;
  /** Everything the bot waits on is a question for the user, not an approval. */
  asking: boolean;
  /** The bot is switched off (listed only where `includeDisabled` asks). */
  disabled: boolean;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The row's one trailing status: attention > error > running > unread. The
 *  task sessions the bot created (taskAgent) are its work too: the bot's own
 *  turn often ends once it hands the work over, while the task still runs. */
function contactIndicator(
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
  if (session?.working || tasks.some((task) => task.working)) return { kind: 'running' };
  if (!session || !unreadSessionIds?.has(session.id)) return null;
  // The chat messages that arrived since the read cursor, a whole number of at
  // least 1; the row caps how it shows it.
  return { kind: 'unread', count: unseenIncomingCount(session) };
}

function contactPreview(
  indicator: AgentChatIndicator,
  session: DesktopSessionSummary | null,
  fallback: string,
  mixy: boolean,
  disabled: boolean
) {
  if (disabled) return t('Off');
  if (indicator?.kind === 'attention') return t('Waiting for approval');
  if (indicator?.kind === 'running') return t('Working');
  // The thread's latest message; a catalog row from before that field (or a
  // cold-scanned one) falls back to its first prompt. Mixy is the default
  // thread: an empty one is normal, so its row shows no placeholder (the
  // thread carries the empty state). A routine result reads in the user's
  // language, as its transcript notice does.
  // Every path reads as plain text: a stored preview from before the host
  // stripped markdown still shows no `**`.
  const shown =
    plainPreviewText(
      localizedRoutinePreview(text(session?.lastMessagePreview), session?.lastMessageRoutine) || text(session?.preview)
    ) || plainPreviewText(fallback);
  return shown || (mixy ? '' : t('No messages yet'));
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
  const homes = new Map<string, DesktopSessionSummary>();
  const tasks = new Map<string, DesktopSessionSummary[]>();
  for (const session of sessions) {
    if (session.archived) continue;
    if (session.agentHome) homes.set(session.agentHome, session);
    if (session.taskAgent) tasks.set(session.taskAgent, [...(tasks.get(session.taskAgent) ?? []), session]);
  }
  const contact = (
    agentId: string,
    name: string,
    storedAvatar: unknown,
    description: string,
    mixy: boolean,
    disabled = false
  ): AgentContact => {
    const session = homes.get(agentId) ?? null;
    const indicator = contactIndicator(
      session,
      tasks.get(agentId) ?? [],
      session ? groups.get(session.id) : undefined,
      unreadSessionIds,
      needsUser
    );
    const waiting = [session, ...(tasks.get(agentId) ?? [])].filter((row) => row && needsUser?.has(row.id));
    const approvalRows = waiting.filter((row) => !asking?.has(row?.id ?? '')).length;
    const questionOnly = indicator?.kind === 'attention' && waiting.length > 0 && approvalRows === 0;
    return {
      agentId,
      name,
      mixy,
      asking: questionOnly,
      approvals: indicator?.kind === 'attention' && !questionOnly ? Math.max(1, approvalRows) : 0,
      avatar: agentAvatar(agentId, storedAvatar),
      session,
      preview: contactPreview(indicator, session, description, mixy, disabled),
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
