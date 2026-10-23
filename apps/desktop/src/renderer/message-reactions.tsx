// The bots' emoji reactions on a user message (message-reactions.mjs), as small
// chips under its bubble; each names the bot that left it on hover.
import { useRoomContacts } from './agent-room-parts';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';

interface MessageReaction {
  agentId: string;
  emoji: string;
}

/** The row's reactions in the order they were left; [] when it has none. */
export function messageReactionsOf(item: TranscriptItem): MessageReaction[] {
  const list = Array.isArray(item.reactions) ? (item.reactions as unknown[]) : [];
  return list.flatMap((entry) => {
    const { agentId, emoji } = (entry ?? {}) as Record<string, unknown>;
    return typeof agentId === 'string' && agentId && typeof emoji === 'string' && emoji ? [{ agentId, emoji }] : [];
  });
}

export function MessageReactions({ reactions }: { reactions: readonly MessageReaction[] }) {
  const { label } = useRoomContacts(true);
  return (
    <ul className="message-reactions" aria-label={t('Reactions')}>
      {reactions.map(({ agentId, emoji }) => {
        const name = label(agentId).name;
        return (
          <li key={agentId} className="message-reaction" title={name}>
            <span aria-hidden="true">{emoji}</span>
            <span className="sr-only">{t('{{name}} reacted {{emoji}}', { name, emoji })}</span>
          </li>
        );
      })}
    </ul>
  );
}
