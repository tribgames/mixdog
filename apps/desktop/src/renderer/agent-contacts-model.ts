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
  /** The bot is switched off (listed only where `includeDisabled` asks). */
  disabled: boolean;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The row's one trailing status: attention > error > running > unread. */
function contactIndicator(
  session: DesktopSessionSummary | null,
  nodes: readonly AgentActivityNode[] | undefined,
  unreadSessionIds: ReadonlySet<string> | undefined
): AgentChatIndicator {
  if (!session) return null;
  const pooled = nodes?.length ? agentGroupIndicator(session.id, nodes, unreadSessionIds) : null;
  if (pooled && pooled.kind !== 'unread') return pooled;
  if (session.working) return { kind: 'running' };
  if (!unreadSessionIds?.has(session.id)) return null;
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

/** Contacts in list order. `groups` are the pool's Lead groups by owner id.
 *  Switched-off bots are left out unless `includeDisabled` (the 봇 page). */
export function agentContacts(
  agents: unknown,
  sessions: readonly DesktopSessionSummary[],
  groups: ReadonlyMap<string, readonly AgentActivityNode[]>,
  unreadSessionIds?: ReadonlySet<string>,
  { includeDisabled = false }: { includeDisabled?: boolean } = {}
): AgentContact[] {
  const homes = new Map<string, DesktopSessionSummary>();
  for (const session of sessions) {
    if (session.agentHome && !session.archived) homes.set(session.agentHome, session);
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
    const indicator = contactIndicator(session, session ? groups.get(session.id) : undefined, unreadSessionIds);
    return {
      agentId,
      name,
      mixy,
      avatar: agentAvatar(agentId, storedAvatar),
      session,
      preview: contactPreview(indicator, session, description, mixy, disabled),
      at: session ? Number(session.activityAt) || session.updatedAt : 0,
      indicator,
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
