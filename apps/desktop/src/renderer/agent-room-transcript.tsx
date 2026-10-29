// A group room's transcript rows (agent-room.mjs): a member's words read as
// ordinary assistant text under a small face and name; a pass is one faint
// line; a limit stop is one such line with an inline "Continue" (no counts,
// the same for rows saved before); the overlay row names who is
// speaking now. The user's own bubble only gains a "→ name" chip.
import { useContext, useEffect, useState } from 'react';
import { roomIdOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { TranscriptItem, TranscriptRoomRow } from './desktop-types';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import MarkdownBody from './MarkdownBody';
import { MarkdownSessionContext } from './MarkdownLink';
import { RoomMemberFace, useRoomContacts } from './agent-room-parts';
import { useAgentRoom } from './agent-room-store';
import { modelDisplayName, providerDisplayName } from './provider-display';
import { quotaRemainingLabel } from './quota-continue';
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

/** Now, refreshed twice a minute while `until` is still ahead. */
function useClockUntil(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [until]);
  return now;
}

/** The room paused on the provider's usage limit: why, on which model and
 *  when it resets. A quota that resets offers "Continue" once the reset has
 *  passed (the limit then clears and the room goes on); a plan or billing
 *  stop offers none, since only a change of model or plan helps. */
function UsageLimitRow({ room }: { room: TranscriptRoomRow }) {
  const usage = room.usage as NonNullable<TranscriptRoomRow['usage']>;
  const now = useClockUntil(usage.resetAt);
  let title = t('Usage limit reached');
  if (usage.kind === 'entitlement') title = t('Not included in your plan');
  else if (usage.kind === 'billing') title = t('Out of credits or at spend limit');
  const route = [
    usage.provider ? providerDisplayName(usage.provider) : '',
    usage.model ? modelDisplayName(usage.model, usage.provider) : '',
  ]
    .filter(Boolean)
    .join(' ');
  const waiting = usage.resetAt !== null && usage.resetAt > now;
  const parts = [
    title,
    route,
    usage.resetAt !== null && usage.kind === 'quota_exhausted'
      ? t('Resets in {{time}}', { time: quotaRemainingLabel(usage.resetAt, now) })
      : '',
  ].filter(Boolean);
  return (
    <div className="agent-room-pass agent-room-cap" role="status">
      <span>{`${t('The conversation paused.')} ${parts.join(' · ')}`}</span>
      {usage.kind === 'quota_exhausted' ? <ContinueButton blocked={waiting} /> : null}
    </div>
  );
}

function ContinueButton({ blocked = false }: { blocked?: boolean }) {
  const sessionId = useContext(MarkdownSessionContext);
  const room = useAgentRoom(sessionId);
  const [pending, setPending] = useState(false);
  const roomId = roomIdOfSession(sessionId);
  return (
    <button
      type="button"
      className="agent-room-continue"
      disabled={!roomId || pending || blocked || room?.running === true}
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
    // A run of failures is one row naming every member and the reason.
    const names = room.names?.length ? room.names.join(', ') : member.name;
    return (
      <div className="agent-room-pass">
        <RoomMemberFace member={member} />
        {t('{{name}} · could not reply', { name: names })}
        {room.reason ? ` · ${room.reason}` : ''}
      </div>
    );
  }
  if (room.kind === 'cap' && room.usage) return <UsageLimitRow room={room} />;
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
