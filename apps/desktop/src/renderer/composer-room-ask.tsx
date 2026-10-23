// A group room's composer: who can be asked (`/ask <agent> <message>`, or the
// + menu's "Call an agent"), the member picker while the agent is being typed,
// and the "→ name" chip once one is named. `@`, `/` and `$` keep their meaning.
import { type RefObject, useMemo, useRef } from 'react';
import { parseRoomAsk } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { agentAvatar } from '../../../../src/runtime/shared/agent-avatar.mjs';
import { RoomMemberFace, type RoomMemberLabel, useRoomContacts } from './agent-room-parts';
import { useAgentRoom } from './agent-room-store';
import { ComposerPalette } from './ComposerPalette';
import { t } from './i18n';
import type { DesktopPromptContent } from '../shared/contract';

/** The members of the room `sessionId` is the log of that a new message can
 *  address (switched-off bots left out); null elsewhere. */
export function useComposerRoomMembers(sessionId?: string): RoomMemberLabel[] | null {
  const room = useAgentRoom(sessionId);
  const { label, disabled } = useRoomContacts(Boolean(room), room?.memberNames);
  return useMemo(
    () => (room ? room.members.filter((id) => !disabled.has(id)).map(label) : null),
    [room, label, disabled]
  );
}

/** The members a draft's `/ask <agent>[, <agent>…]` already names, in order. */
export function roomAskTargets(draft: string, members: readonly RoomMemberLabel[] | null): RoomMemberLabel[] {
  if (!members) return [];
  return parseRoomAsk(draft, members).to.flatMap((id) => members.filter((member) => member.id === id));
}

/** The draft with `/ask <id>[, <id>…] ` in front of what it said (any earlier /ask dropped). */
export function draftAsking(draft: string, agentIds: string | readonly string[]): string {
  const ids = typeof agentIds === 'string' ? [agentIds] : agentIds;
  return `/ask ${ids.join(', ')} ${draft.replace(/^\s*\/ask(?:\s+\S*)?\s*/i, '')}`;
}

/** A draft still typing its `/ask` targets: the ones listed before a comma, and the one being typed. */
const ASKING = /^\/ask\s+((?:[^,\n]*,\s*)*)(\S*)$/i;

/** The draft with `agentId` picked: added after the targets a comma already lists. */
export function draftAskingMore(draft: string, agentId: string): string {
  const listed = ASKING.exec(draft)?.[1];
  return listed ? `/ask ${listed}${agentId} ` : draftAsking(draft, agentId);
}

/** The members a draft that is still typing an `/ask` target could mean. */
export function roomAskCandidates(draft: string, members: readonly RoomMemberLabel[] | null): RoomMemberLabel[] {
  const match = members ? ASKING.exec(draft) : null;
  if (!match || !members) return [];
  const listed = match[1]
    ? parseRoomAsk(`/ask ${match[1].replace(/,\s*$/, '')} .`, members)
    : { to: [] as string[], error: undefined };
  if (listed.error) return [];
  return roomMentionCandidates(match[2], members).filter((member) => !listed.to.includes(member.id));
}

export function RoomAskPalette({
  anchor,
  members,
  selected = -1,
  onSelect,
}: {
  anchor: RefObject<HTMLElement | null>;
  members: readonly RoomMemberLabel[];
  /** The keyboard-highlighted row; -1 for none. */
  selected?: number;
  onSelect(agentId: string): void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  return (
    <ComposerPalette anchor={anchor} panel={panel} id="composer-room-ask-palette" label={t('Call a bot')}>
      <header>
        <span>{t('Ask members')}</span>
      </header>
      {members.map((member, index) => (
        <button
          type="button"
          role="option"
          aria-selected={index === selected}
          key={member.id}
          className="agent-room-ask-option"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(member.id)}
        >
          <RoomMemberFace member={member} />
          <span>{member.name}</span>
        </button>
      ))}
    </ComposerPalette>
  );
}

/** Agent mode's `@` in a room: the members whose id or name starts with what
 *  follows the `@`. */
export function roomMentionCandidates(query: string, members: readonly RoomMemberLabel[] | null): RoomMemberLabel[] {
  const lower = query.toLowerCase();
  return (members ?? []).filter(
    (member) => member.id.toLowerCase().startsWith(lower) || member.name.toLowerCase().startsWith(lower)
  );
}

/** The picker's "Everyone" tag (`@all`): not a member id, resolved to the room's current members at send. */
export const ROOM_EVERYONE = '@all';

function everyoneLabel(): RoomMemberLabel {
  return { id: ROOM_EVERYONE, name: t('Everyone'), avatar: agentAvatar(ROOM_EVERYONE, null) };
}

/** The `@` tag picker's rows: the members `roomMentionCandidates` finds, then
 *  "Everyone" while `query` starts "all" or its name (and the room has members). */
export function roomTagCandidates(query: string, members: readonly RoomMemberLabel[] | null): RoomMemberLabel[] {
  const everyone = everyoneLabel();
  const lower = query.toLowerCase();
  const found = roomMentionCandidates(query, members);
  return members?.length && ['all', everyone.name.toLowerCase()].some((label) => label.startsWith(lower))
    ? [...found, everyone]
    : found;
}

/** The tags (member ids, or Everyone) that still name something in the room, in tag order. */
export function roomTaggedMembers(
  tagged: readonly string[],
  members: readonly RoomMemberLabel[] | null
): RoomMemberLabel[] {
  return tagged.flatMap((id) =>
    id === ROOM_EVERYONE
      ? members?.length
        ? [everyoneLabel()]
        : []
      : (members ?? []).filter((member) => member.id === id)
  );
}

/** The member ids a message to these tags addresses: Everyone is the room's members
 *  (room order), and nobody is named twice. */
export function roomTagTargets(tagged: readonly RoomMemberLabel[], members: readonly RoomMemberLabel[]): string[] {
  const active = members.map((member) => member.id);
  return [...new Set(tagged.flatMap((member) => (member.id === ROOM_EVERYONE ? active : [member.id])))];
}

/** A message tagged for members goes out on the room's `/ask` path, in tag order. */
export function contentAsking(content: DesktopPromptContent, agentIds: readonly string[]): DesktopPromptContent {
  if (typeof content === 'string') return draftAsking(content, agentIds);
  const at = content.findIndex((part) => part.type === 'text');
  if (at < 0) return [{ type: 'text', text: draftAsking('', agentIds) }, ...content];
  return content.map((part, index) =>
    index === at && part.type === 'text' ? { ...part, text: draftAsking(part.text, agentIds) } : part
  );
}

/** The tag chip in front of the input: who answers this message. */
export function RoomMentionChip({ member, onRemove }: { member: RoomMemberLabel; onRemove(): void }) {
  return (
    <button
      type="button"
      className="mx-chat-tag"
      aria-label={t('Remove {{name}}', { name: member.name })}
      onClick={onRemove}
    >
      {`@${member.name}`}
    </button>
  );
}

export function RoomAskChip({ members }: { members: readonly RoomMemberLabel[] }) {
  return (
    <span className="agent-room-to composer-room-ask">
      {members.map((member) => (
        <RoomMemberFace key={member.id} member={member} />
      ))}
      {`→ ${members.map((member) => member.name).join(', ')}`}
    </span>
  );
}
