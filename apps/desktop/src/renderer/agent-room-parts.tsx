// Group-room pieces every room surface shares: who the members are (name and
// face from the contacts), the tiled room face, and one member's face.
import { useMemo } from 'react';
import { agentAvatar } from '../../../../src/runtime/shared/agent-avatar.mjs';
import { AgentAvatar } from './agent-avatar';
import type { AvatarMotionState } from './avatar-motion';
import { type AgentContact, agentContacts } from './agent-contacts-model';
import { useArchivedBotIdentities } from './archived-bot-identity';
import { t } from './i18n';
import { useSidebarReferences } from './sidebar-reference-cache';
import './agent-rooms.css';

const CONTACT_KEYS = ['agents'] as const;
const NO_SESSIONS: never[] = [];
const NO_GROUPS = new Map();

export interface RoomMemberLabel {
  id: string;
  name: string;
  avatar: AgentContact['avatar'];
}

/** Every contact (Mixy first) by agent id: the names and faces rooms show. */
export function useRoomContacts(
  active = true,
  /** The room's own name map (host-resolved), for an agent the contacts cache has not caught up with. */
  memberNames?: Readonly<Record<string, string>>
): { contacts: AgentContact[]; label(id: string): RoomMemberLabel } {
  // Outside a room (a composer, a coding transcript) nothing loads.
  const { values } = useSidebarReferences(window.mixdogDesktop, CONTACT_KEYS, active, false);
  // A deleted bot (its read-only chat) keeps the name and face it left.
  const archived = useArchivedBotIdentities();
  return useMemo(() => {
    const contacts = agentContacts(values.agents, NO_SESSIONS, NO_GROUPS);
    const byId = new Map(contacts.map((contact) => [contact.agentId, contact]));
    return {
      contacts,
      label: (id: string): RoomMemberLabel => {
        const contact = byId.get(id) ?? archived.get(id);
        return contact
          ? { id, name: contact.name, avatar: contact.avatar }
          : { id, name: memberNames?.[id] || id, avatar: agentAvatar(id, null) };
      },
    };
  }, [values.agents, memberNames, archived]);
}

/** One member's face. */
export function RoomMemberFace({
  member,
  className = '',
  state,
}: {
  member: RoomMemberLabel;
  className?: string;
  /** A motion to ask for (agent-avatar.tsx); still by default. */
  state?: AvatarMotionState;
}) {
  return (
    <span className={`agent-room-face ${className}`.trim()}>
      <AgentAvatar agentId={member.id} avatar={member.avatar} state={state} />
    </span>
  );
}

/** A room's face: a cluster of its members' round faces in stored order, up
 *  to four; past four, three faces and a "+N" for the rest. */
export function RoomAvatar({ members, className = '' }: { members: readonly RoomMemberLabel[]; className?: string }) {
  const shown = members.length > 4 ? members.slice(0, 3) : members;
  const more = members.length - shown.length;
  return (
    <span
      className={`agent-room-tile ${className}`.trim()}
      data-count={Math.min(members.length, 4)}
      role="img"
      aria-label={t('{{count}} members', { count: members.length })}
    >
      {shown.map((member) => (
        <RoomMemberFace key={member.id} member={member} />
      ))}
      {more > 0 && (
        <span className="agent-room-more" aria-hidden="true">
          {`+${more}`}
        </span>
      )}
    </span>
  );
}
