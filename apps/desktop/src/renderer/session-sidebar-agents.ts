// The Sessions sidebar's Agents section: Mixy first, then the user's agents in
// the Agents pane's order (agentContacts), each opening its home chat on the
// Agents page.
import { useMemo } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import { type AgentContact, agentContacts } from './agent-contacts-model';
import { openAgentProfile } from './agent-panel-tab';
import { type RoomMemberLabel, useRoomContacts } from './agent-room-parts';
import { type AgentRoomRowModel, agentRoomRows } from './agent-rooms-model';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { useMixyCreated } from './mixy-first';
import { useSidebarReferences } from './sidebar-reference-cache';
import { useStableEvent } from './use-stable-event';

/** A room row with its members' labels resolved, ready for the section. */
export type SidebarRoomRow = AgentRoomRowModel & { members: RoomMemberLabel[] };

const AGENT_KEYS = ['agents'] as const;
const NO_GROUPS: ReadonlyMap<string, never[]> = new Map();

export function useSidebarAgents(
  sessions: readonly DesktopSessionSummary[],
  unreadSessionIds: ReadonlySet<string> | undefined,
  active: boolean,
  onOpenAgent: ((sessionId: string, title: string) => void) | undefined
) {
  const { values } = useSidebarReferences(window.mixdogDesktop, AGENT_KEYS, active);
  const mixyCreated = useMixyCreated(window.mixdogDesktop, active);
  const contacts = useMemo(
    () =>
      agentContacts(values.agents, sessions, NO_GROUPS, unreadSessionIds).filter(
        (contact) => !contact.mixy || mixyCreated === true
      ),
    [values.agents, sessions, unreadSessionIds, mixyCreated]
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
  return { contacts, rooms, openRoom, openAgent, openAgentProfile: openAgentProfileOf };
}
