// Agent mode's chat faces (agent-chat-mode.ts): the empty thread's profile
// intro and a bot chat tab's glyph. A bot chat sits in the shared tab strip
// like any session, on the phone too.
import { MIXY_AGENT_ID, agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { RoomAvatar, RoomMemberFace, useRoomContacts } from './agent-room-parts';
import { useAgentRoom } from './agent-room-store';
import { t } from './i18n';
import { useSidebarReferences } from './sidebar-reference-cache';
import './agent-chat.css';

const AGENT_KEYS = ['agents'] as const;

/** A chat with no messages yet: the contact's profile at the top of the
 *  thread (a large face, the name and what it does), as messengers open a
 *  new chat. A room shows its tiled face and its members. */
export function AgentChatIntro({ sessionId }: { sessionId: string }) {
  const room = useAgentRoom(sessionId);
  const { label } = useRoomContacts(true, room?.memberNames);
  const { values } = useSidebarReferences(window.mixdogDesktop, AGENT_KEYS, true);
  const agentId = agentIdOfHomeSession(sessionId) || MIXY_AGENT_ID;
  const member = label(agentId);
  const row = Array.isArray(values.agents)
    ? (values.agents as Array<{ id?: unknown; description?: unknown }>).find((entry) => entry?.id === agentId)
    : undefined;
  const role = room
    ? room.members.map((id) => label(id).name).join(', ')
    : typeof row?.description === 'string' && row.description.trim()
      ? row.description.trim()
      : agentId === MIXY_AGENT_ID
        ? t('Primary assistant')
        : '';
  return (
    <div className="mx-chat-intro">
      {room ? (
        <RoomAvatar members={room.members.map(label)} className="mx-chat-intro-face" />
      ) : (
        <RoomMemberFace member={member} className="mx-chat-intro-face" />
      )}
      <b>{room?.name || member.name}</b>
      {role && <span>{role}</span>}
    </div>
  );
}

/** A bot chat tab's glyph: the thread's face, or a room's tiled face. */
export function AgentChatTabFace({ sessionId }: { sessionId: string }) {
  const room = useAgentRoom(sessionId);
  const { label } = useRoomContacts(true, room?.memberNames);
  return room ? (
    <RoomAvatar members={room.members.map(label)} className="mx-chat-tab-face" />
  ) : (
    <RoomMemberFace member={label(agentIdOfHomeSession(sessionId) || MIXY_AGENT_ID)} className="mx-chat-tab-face" />
  );
}
