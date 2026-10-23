// session/message-reactions.mjs
// A bot's emoji reaction on a message the user wrote, shown under the user's
// bubble. It is stored on that message (`meta.transcript.reactions`, one
// `{ agentId, emoji, at }` per bot), so it travels with the transcript: a
// reload, a restart and every synced client read it from there. In a group
// room the message is the user's row in the room's log, and each member's
// reaction is kept beside the others'.
import { sessionMessageText } from '../runtime-core/session-text.mjs';
import { isInternalTranscriptDisplayText } from '../../../shared/tool-execution-contract.mjs';
import { normalizeMessageReactions } from '../../../shared/transcript-metadata.mjs';
import { isRoomRowMessage } from './agent-room.mjs';

/** Whether `message` is one the user wrote: a prompt typed (or steered) into
 *  the chat, or the user's own row in a room's log. Runtime notices, routine
 *  fires, posted results and other bots' messages are not. */
export function isReactableMessage(message) {
  if (message?.role !== 'user' || !message.meta || typeof message.meta !== 'object') return false;
  const { meta } = message;
  const transcript = meta.transcript;
  if (typeof transcript?.messageId !== 'string' || !transcript.messageId) return false;
  if (isRoomRowMessage(message)) return meta.room.kind === 'user' && !meta.room.fromSession;
  if ((meta.source && meta.source !== 'steering') || meta.synthetic === true) return false;
  if (transcript.fromAgent || transcript.routineTrigger) return false;
  return !isInternalTranscriptDisplayText(sessionMessageText(message.content));
}

/**
 * Set `agentId`'s reaction (`emoji`; '' removes it) on the user message
 * `messagesBack` user messages before the newest one in `messages`. One
 * reaction per bot: a new one takes the place of the old. `othersKeep`: an
 * emoji another bot already left there is refused (a group room's members do
 * not repeat each other). Returns `{ previous, message, messageId, reactions,
 * changed }`; `message` is a new object (the store's delta saves see a change
 * by identity), placed by the caller. Throws when there is no such message.
 */
export function reactToMessage(messages, { agentId, emoji, messagesBack = 0, othersKeep = false, at = Date.now() }) {
  const list = Array.isArray(messages) ? messages : [];
  let seen = 0;
  let previous = null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (!isReactableMessage(list[index])) continue;
    if (seen === messagesBack) {
      previous = list[index];
      break;
    }
    seen += 1;
  }
  if (!previous) {
    throw new Error(
      seen ? `react: there are only ${seen} user messages to react to` : 'react: there is no user message to react to'
    );
  }
  const transcript = previous.meta.transcript;
  const current = normalizeMessageReactions(transcript.reactions);
  const own = current.find((entry) => entry.agentId === agentId);
  if (emoji && othersKeep) {
    const taken = current.find((entry) => entry.agentId !== agentId && entry.emoji === emoji);
    if (taken) throw new Error(`react: ${taken.agentId} already left ${emoji} on that message`);
  }
  const messageId = transcript.messageId;
  if (own?.emoji === emoji || (!own && !emoji)) {
    return { previous, message: previous, messageId, reactions: current, changed: false };
  }
  const entry = { agentId, emoji, at };
  const reactions = emoji
    ? own
      ? current.map((each) => (each.agentId === agentId ? entry : each))
      : [...current, entry]
    : current.filter((each) => each.agentId !== agentId);
  const { reactions: _old, ...rest } = transcript;
  const message = {
    ...previous,
    meta: { ...previous.meta, transcript: reactions.length ? { ...rest, reactions } : rest },
  };
  return { previous, message, messageId, reactions, changed: true };
}

/** reactToMessage on a stored session: the running turn's working transcript
 *  when a turn is in flight (its end commits that transcript), and the
 *  session's own message list, both holding the replaced message. */
export function reactInSession(session, change) {
  const working = Array.isArray(session?.liveTurnMessages) ? session.liveTurnMessages : null;
  const result = reactToMessage(working || session?.messages, change);
  if (!result.changed) return result;
  for (const list of [working, session.messages]) {
    const index = Array.isArray(list) ? list.indexOf(result.previous) : -1;
    if (index >= 0) list[index] = result.message;
  }
  return result;
}
