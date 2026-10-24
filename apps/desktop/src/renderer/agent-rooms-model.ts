// The Agents pane's room rows: one per group room, built from the session
// catalog (the host stamps each room's log with `agentRoom`) and the contacts.
import { plainPreviewText } from '../../../../src/runtime/shared/plain-preview.mjs';
import type { DesktopAgentRoomSummary, DesktopSessionSummary } from '../shared/contract';
import { unseenIncomingCount } from '../shared/incoming-tail';
import type { AgentChatIndicator } from './agent-chat-summary';
import { t } from './i18n';

export interface RoomLabel {
  id: string;
  name: string;
}

export interface AgentRoomRowModel {
  sessionId: string;
  room: DesktopAgentRoomSummary;
  session: DesktopSessionSummary;
  name: string;
  /** Who said the last line ("You" for the user); '' before anyone spoke. */
  speaker: string;
  preview: string;
  at: number;
  indicator: AgentChatIndicator;
  /** The room holds an unread reply, even while a running badge takes the slot. */
  unread: boolean;
}

/** The row's spoken label: its name and member count, only the parts that
 *  exist (a nameless room reads "2 members", never ", 2 members"). */
export function roomRowLabel(name: string, memberCount: number): string {
  return [name.trim(), memberCount > 0 ? t('{{count}} members', { count: memberCount }) : '']
    .filter(Boolean)
    .join(', ');
}

/** Rooms in list order, newest activity first; archived (left) rooms stay out. */
function roomSpeaker(room: DesktopAgentRoomSummary, preview: string, label: (agentId: string) => RoomLabel): string {
  if (!preview) return '';
  if (room.lastSpeaker === 'user') return t('You');
  if (!room.lastSpeaker) return '';
  if (label(room.lastSpeaker).name === room.lastSpeaker) {
    return room.memberNames?.[room.lastSpeaker] || room.lastSpeaker;
  }
  return label(room.lastSpeaker).name;
}

export function agentRoomRows(
  sessions: readonly DesktopSessionSummary[],
  label: (agentId: string) => RoomLabel,
  unreadSessionIds?: ReadonlySet<string>
): AgentRoomRowModel[] {
  return sessions
    .filter((session): session is DesktopSessionSummary & { agentRoom: DesktopAgentRoomSummary } =>
      Boolean(session.agentRoom && !session.archived)
    )
    .map((session) => {
      const room = session.agentRoom;
      const preview = plainPreviewText(String(room.lastPreview || session.lastMessagePreview || ''));
      const indicator: AgentChatIndicator = room.running
        ? { kind: 'running' }
        : unreadSessionIds?.has(session.id)
          ? { kind: 'unread', count: unseenIncomingCount(session) }
          : null;
      return {
        sessionId: session.id,
        room,
        session,
        name: room.name,
        speaker: roomSpeaker(room, preview, label),
        preview: preview || t('No messages yet'),
        at: Number(session.activityAt) || session.updatedAt || 0,
        indicator,
        unread: unreadSessionIds?.has(session.id) === true,
      };
    })
    .sort((left, right) => right.at - left.at || left.sessionId.localeCompare(right.sessionId));
}
