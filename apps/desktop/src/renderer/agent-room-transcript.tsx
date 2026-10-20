// A group room's transcript rows (agent-room.mjs): a member's words read as
// ordinary assistant text under a small face and name; a pass is one faint
// line; a limit stop is one such line with an inline "Continue" (no counts,
// the same for rows saved before); the overlay row names who is
// speaking now. The user's own bubble only gains a "→ name" chip.
import { useContext, useState } from 'react';
import { roomIdOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { TranscriptItem, TranscriptRoomRow } from './desktop-types';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import MarkdownBody from './MarkdownBody';
import { MarkdownSessionContext } from './MarkdownLink';
import { RoomMemberFace, useRoomContacts } from './agent-room-parts';
import { useAgentRoom } from './agent-room-store';
import { CopyControl } from './transcript-primitives';

function useSpeaker(room: TranscriptRoomRow) {
  const { label } = useRoomContacts();
  const member = label(room.speaker || '');
  // The row keeps the name it was said under; the face follows the contact.
  return { ...member, name: room.name || member.name };
}

/** The "→ A, B" chip on a bubble addressed to members: a user message's
 *  addressees, or the one peer a member's @mention names. */
export function RoomAddressChip({ room, fromUser = false }: { room: TranscriptRoomRow; fromUser?: boolean }) {
  const { label } = useRoomContacts();
  const members = (room.to ?? []).map((id, index) => ({ ...label(id), name: room.toName?.[index] || label(id).name }));
  if (fromUser) {
    // The user's own words: plain "To: A, B" text, no bot face, so it can't read as bot-to-bot.
    return (
      <span className="agent-room-to-user">
        {t('To: {{names}}', { names: members.map((member) => `@${member.name}`).join(', ') })}
      </span>
    );
  }
  return (
    <span className="agent-room-to">
      {members.map((member) => (
        <RoomMemberFace key={member.id} member={member} />
      ))}
      {`→ ${members.map((member) => member.name).join(', ')}`}
    </span>
  );
}

function ContinueButton() {
  const sessionId = useContext(MarkdownSessionContext);
  const room = useAgentRoom(sessionId);
  const [pending, setPending] = useState(false);
  const roomId = roomIdOfSession(sessionId);
  return (
    <button
      type="button"
      className="agent-room-continue"
      disabled={!roomId || pending || room?.running === true}
      onClick={() => {
        setPending(true);
        void Promise.resolve(window.mixdogDesktop?.agentRoomAction?.('continue', [roomId]))
          .catch((error) => showDesktopToast(errorMessageText(error), 'error'))
          .finally(() => setPending(false));
      }}
    >
      {t('Continue')}
    </button>
  );
}

export function RoomTranscriptRow({ item }: { item: TranscriptItem }) {
  const room = item.room as TranscriptRoomRow;
  const member = useSpeaker(room);
  if (room.kind === 'speech') {
    const text = String(item.text || '');
    return (
      <article className="message assistant settled agent-room-speech">
        <div className="agent-room-who">
          <RoomMemberFace member={member} />
          <span>{member.name}</span>
        </div>
        {room.to?.length ? <RoomAddressChip room={room} /> : null}
        <div className="message-body">
          <MarkdownBody text={text} copyControl={CopyControl} />
        </div>
      </article>
    );
  }
  if (room.kind === 'typing') {
    return (
      <div className="agent-room-who agent-room-typing" role="status">
        <RoomMemberFace member={member} />
        <span>{member.name}</span>
        <span className="agent-room-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    );
  }
  if (room.kind === 'pass') {
    // A member that chose to stay quiet leaves no trace; only a failed turn shows.
    if (!room.failed) return null;
    return (
      <div className="agent-room-pass">
        <RoomMemberFace member={member} />
        {t('{{name}} · could not reply', { name: member.name })}
      </div>
    );
  }
  if (room.kind === 'cap') {
    return (
      <div className="agent-room-pass agent-room-cap" role="status">
        <span>{t('The conversation paused.')}</span>
        <ContinueButton />
      </div>
    );
  }
  return (
    <div className="notice agent-room-notice" role="status">
      {room.kind === 'interrupted' ? t('Interrupted') : t('Stopped the conversation.')}
    </div>
  );
}
