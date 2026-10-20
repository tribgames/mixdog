// The Agents pane's room rows: one per group room, built from the session
// catalog (the host stamps each room's log with `agentRoom`) and the contacts.
import { plainPreviewText } from '../../../../src/runtime/shared/plain-preview.mjs';
import type { DesktopAgentRoomSummary, DesktopSessionSummary } from '../shared/contract';
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
}

/** Rooms in list order, newest activity first; archived (left) rooms stay out. */
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
      const unseen = Math.floor((Number(session.messageCount) || 0) - (Number(session.readMessageCount) || 0));
      const indicator: AgentChatIndicator = room.running
        ? { kind: 'running' }
        : unreadSessionIds?.has(session.id)
          ? { kind: 'unread', count: Math.max(1, unseen) }
          : null;
      const speaker = !preview
        ? ''
        : room.lastSpeaker === 'user'
          ? t('You')
          : room.lastSpeaker
            ? label(room.lastSpeaker).name === room.lastSpeaker
              ? room.memberNames?.[room.lastSpeaker] || room.lastSpeaker
              : label(room.lastSpeaker).name
            : '';
      return {
        sessionId: session.id,
        room,
        session,
        name: room.name,
        speaker,
        preview: preview || t('No messages yet'),
        at: Number(session.activityAt) || session.updatedAt || 0,
        indicator,
      };
    })
    .sort((left, right) => right.at - left.at || left.sessionId.localeCompare(right.sessionId));
}
