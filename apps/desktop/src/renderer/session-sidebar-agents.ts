// The Sessions sidebar's Agents section: Mixy first, then the user's agents in
// the Agents pane's order (agentContacts), each opening its home chat on the
// Agents page.
import { useMemo } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import { type AgentContact, agentContacts } from './agent-contacts-model';
import { openAgentProfile } from './agent-panel-tab';
import { type RoomMemberLabel, useRoomContacts } from './agent-room-parts';
import { type AgentRoomRowModel, agentRoomRows } from './agent-rooms-model';
import { applyBotOrder, useBotOrder } from './bot-order-store';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { useMixyCreated } from './mixy-first';
import { useSidebarHiddenBots } from './sidebar-hidden-bots-store';
import { useSidebarReferences } from './sidebar-reference-cache';
import { useStableEvent } from './use-stable-event';
import { MIXY_AGENT_ID, contactAgentRows } from '../shared/agent-contacts';

/** A room row with its members' labels resolved, ready for the section. */
export type SidebarRoomRow = AgentRoomRowModel & { members: RoomMemberLabel[] };

const AGENT_KEYS = ['agents'] as const;
const NO_GROUPS: ReadonlyMap<string, never[]> = new Map();

export function useSidebarAgents(
  sessions: readonly DesktopSessionSummary[],
  unreadSessionIds: ReadonlySet<string> | undefined,
  active: boolean,
  onOpenAgent: ((sessionId: string, title: string) => void) | undefined,
  needsUserSessionIds?: ReadonlySet<string>,
  askingSessionIds?: ReadonlySet<string>
) {
  const { values } = useSidebarReferences(window.mixdogDesktop, AGENT_KEYS, active);
  const mixyCreated = useMixyCreated(window.mixdogDesktop, active);
  const hidden = useSidebarHiddenBots();
  const order = useBotOrder(); // the Bots page's order, shared through the host
  const contacts = useMemo(
    () =>
      applyBotOrder(
        agentContacts(values.agents, sessions, NO_GROUPS, unreadSessionIds, {
          needsUser: needsUserSessionIds,
          asking: askingSessionIds,
        }).filter(
          (contact) =>
            (!contact.mixy || mixyCreated === true) &&
            // A hidden bot shows again while it has unread messages or waits on the user.
            (!hidden.has(contact.agentId) ||
              contact.indicator?.kind === 'unread' ||
              (contact.session !== null && needsUserSessionIds?.has(contact.session.id) === true))
        ),
        order
      ),
    [values.agents, sessions, unreadSessionIds, mixyCreated, hidden, needsUserSessionIds, askingSessionIds, order]
  );
  // The 봇 page's room list, same data and order; opens like a bot row.
  const { label } = useRoomContacts(active);
  const rooms = useMemo(
    () =>
      agentRoomRows(sessions, label, unreadSessionIds).map((row) => ({ ...row, members: row.room.members.map(label) })),
    [label, sessions, unreadSessionIds]
  );
  const openRoom = useStableEvent((row: SidebarRoomRow) => onOpenAgent?.(row.sessionId, row.name));
  const openAgent = useStableEvent(async (contact: AgentContact): Promise<string> => {
    try {
      const sessionId =
        contact.session?.id ?? (await window.mixdogDesktop?.openAgentHome?.(contact.agentId))?.sessionId ?? '';
      if (sessionId) onOpenAgent?.(sessionId, contact.name);
      return sessionId;
    } catch (error) {
      showDesktopToast(
        t('Could not open {{name}}: {{error}}', { name: contact.name, error: errorMessageText(error) }),
        'error'
      );
      return '';
    }
  });
  // 프로필 보기 from the row's menu: its chat opens with the profile beside it.
  const openAgentProfileOf = useStableEvent((contact: AgentContact) => {
    void openAgent(contact).then(openAgentProfile);
  });
  const contactHomeIds = useMemo(() => contactHomeAgentIds(values.agents), [values.agents]);
  return { contacts, rooms, openRoom, openAgent, openAgentProfile: openAgentProfileOf, contactHomeIds };
}

/** The agents whose home thread is a contact row (Mixy and every listed bot);
 *  null until the catalog is loaded. Any other agent's home — a former bot
 *  that is a workflow agent again, or a bot switched off — stays a session. */
export function contactHomeAgentIds(agents: unknown): ReadonlySet<string> | null {
  if (agents === undefined) return null;
  return new Set([MIXY_AGENT_ID, ...contactAgentRows(agents).map((row) => row.id)]);
}

/** Whether a session row lists in Sessions as far as agent homes go: not a
 *  home, an archived one, or the home of an agent that is no contact. */
export function listsAsSession(
  session: Pick<DesktopSessionSummary, 'agentHome' | 'archived'>,
  contactHomeIds: ReadonlySet<string> | null
): boolean {
  if (!session.agentHome || session.archived) return true;
  return contactHomeIds !== null && !contactHomeIds.has(session.agentHome);
}
