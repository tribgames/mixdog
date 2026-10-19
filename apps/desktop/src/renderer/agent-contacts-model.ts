// The Agents pane's contacts: Mixy first, then each user-facing agent, every
// one a messenger row over its home thread. Built only from the agent catalog,
// the session catalog (the host stamps each home thread with its agent) and
// the agent pool the pane already reads.
import { MIXY_AGENT_ID, contactAgentRows } from '../shared/agent-contacts';
import type { DesktopSessionSummary } from '../shared/contract';
import type { AgentActivityNode } from './agent-activity-model';
import { type AgentChatIndicator, agentSessionChatSummary } from './agent-chat-summary';
import { t } from './i18n';

export interface AgentContact {
  agentId: string;
  name: string;
  mixy: boolean;
  /** The provider of the model the agent runs on (its avatar); '' for Mixy. */
  provider: string;
  /** The home thread, once it holds a conversation. */
  session: DesktopSessionSummary | null;
  preview: string;
  at: number;
  indicator: AgentChatIndicator;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function routeProvider(route: unknown): string {
  const leaf = Array.isArray(route) ? route[0] : route;
  return leaf && typeof leaf === 'object' ? text((leaf as { provider?: unknown }).provider) : '';
}

/** The row's one trailing status: attention > error > running > unread. */
function contactIndicator(
  session: DesktopSessionSummary | null,
  nodes: readonly AgentActivityNode[] | undefined,
  unreadSessionIds: ReadonlySet<string> | undefined
): AgentChatIndicator {
  if (!session) return null;
  const pooled = nodes?.length ? agentSessionChatSummary(session.id, nodes, unreadSessionIds).indicator : null;
  if (pooled && pooled.kind !== 'unread') return pooled;
  if (session.working) return { kind: 'running' };
  if (!unreadSessionIds?.has(session.id)) return null;
  return { kind: 'unread', count: Math.max(1, session.messageCount - (session.readMessageCount ?? 0)) };
}

function contactPreview(indicator: AgentChatIndicator, session: DesktopSessionSummary | null, fallback: string) {
  if (indicator?.kind === 'attention') return t('Waiting for approval');
  if (indicator?.kind === 'running') return t('Working');
  return text(session?.preview) || fallback || t('No messages yet');
}

/** Contacts in list order. `groups` are the pool's Lead groups by owner id. */
export function agentContacts(
  agents: unknown,
  sessions: readonly DesktopSessionSummary[],
  groups: ReadonlyMap<string, readonly AgentActivityNode[]>,
  unreadSessionIds?: ReadonlySet<string>
): AgentContact[] {
  const homes = new Map<string, DesktopSessionSummary>();
  for (const session of sessions) {
    if (session.agentHome && !session.archived) homes.set(session.agentHome, session);
  }
  const contact = (
    agentId: string,
    name: string,
    provider: string,
    description: string,
    mixy: boolean
  ): AgentContact => {
    const session = homes.get(agentId) ?? null;
    const indicator = contactIndicator(session, session ? groups.get(session.id) : undefined, unreadSessionIds);
    return {
      agentId,
      name,
      mixy,
      provider,
      session,
      preview: contactPreview(indicator, session, description),
      at: session ? Number(session.activityAt) || session.updatedAt : 0,
      indicator,
    };
  };
  // Mixy's name is a brand name: the same in every locale.
  return [
    contact(MIXY_AGENT_ID, 'Mixy', '', '', true),
    ...contactAgentRows(agents).map((row) => {
      const definition = row.definition && typeof row.definition === 'object' ? row.definition : {};
      const name = text((definition as { name?: unknown }).name) || text(row.label) || row.id;
      return contact(row.id, name, routeProvider(row.route), text(row.description), false);
    }),
  ];
}
