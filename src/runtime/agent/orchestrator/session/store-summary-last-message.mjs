/**
 * The summary's last-message line (a messenger row's preview): the newest
 * user or assistant message with displayable text, and that line's routine
 * provenance. Leaf module, shared by the summary index (store saves) and the
 * catalog's strict file scan so both derive the same line.
 */
import { cleanSessionPreview, isSessionPreviewNoise, sessionMessageText } from '../runtime-core/session-text.mjs';
import { plainPreviewText } from '../../../shared/plain-preview.mjs';
import { isRoutineResultMessage, routineProvenance, routineResultNotice } from './routine-result.mjs';
import { agentIdOfHomeSession } from './agent-home.mjs';
import { roomIdOfSession } from './agent-room.mjs';

export const LAST_MESSAGE_PREVIEW_MAX = 160;

/** cleanSessionPreview cut back to a word boundary within `max`. */
export function cleanSummaryPreview(text, max) {
  const value = cleanSessionPreview(text, max);
  return value.length > max
    ? value
        .slice(0, max)
        .replace(/\s+\S*$/, '')
        .trim()
    : value;
}

/** The raw text a conversational message contributes as the last line (a
 *  routine result: its notice line); null for any other message. */
export function lastMessageRawText(message) {
  if (message?.role !== 'user' && message?.role !== 'assistant') return null;
  return isRoutineResultMessage(message) ? routineResultNotice(message).text : sessionMessageText(message.content);
}

/** The message's last-message line, '' when it has none (tool-only, synthetic,
 *  or the runtime's own task-notification envelopes). */
export function lastMessageLine(message) {
  const raw = lastMessageRawText(message);
  if (raw === null || isSessionPreviewNoise(raw) || raw.trimStart().startsWith('<task-notification>\n')) return '';
  return cleanSummaryPreview(plainPreviewText(raw), LAST_MESSAGE_PREVIEW_MAX);
}

/** Most unseen messages a row can report: one past the pill's 99, so a full
 *  tail still reads as "99+". */
export const INCOMING_TAIL_MAX = 100;

/** Only a bot's home thread or a group room's log shows an unread count, so
 *  only their summaries carry the incoming tail. */
export function wantsIncomingTail(sessionId) {
  return Boolean(agentIdOfHomeSession(sessionId) || roomIdOfSession(sessionId));
}

/** Whether `message` is of a kind that arrives as a chat message the user did
 *  not write: an assistant turn that is not a tool call, or a posted result
 *  (routine, task report, bot-to-bot). A user prompt, a tool-call turn and a
 *  tool result are not. Text is checked separately (lastMessageLine). */
export function isIncomingKind(message) {
  if (isRoutineResultMessage(message)) return true;
  if (message?.role !== 'assistant') return false;
  const content = Array.isArray(message.content) ? message.content : [];
  return !(message.toolCalls?.length > 0) && !content.some((part) => part?.type === 'tool_use');
}

/** The incoming messages with text among the last of a transcript, each as
 *  its 1-based place among the user/assistant messages (the numbering of
 *  `messageCount` and of the read cursor), oldest first, at most
 *  INCOMING_TAIL_MAX of them. */
export function incomingTailOf(messages) {
  const tail = [];
  let ordinal = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    ordinal += 1;
    if (isIncomingKind(message) && lastMessageLine(message)) tail.push(ordinal);
  }
  return tail.slice(-INCOMING_TAIL_MAX);
}

/** A stored incoming tail as a clean ascending list of whole places. */
export function normalizedIncomingTail(value) {
  const places = (Array.isArray(value) ? value : []).filter((place) => Number.isSafeInteger(place) && place > 0);
  return places.slice(-INCOMING_TAIL_MAX);
}

/** `{ lastMessagePreview, lastMessageRoutine }` of a transcript. */
export function lastMessageSummary(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const line = lastMessageLine(list[index]);
    if (line) return { lastMessagePreview: line, lastMessageRoutine: routineProvenance(list[index]) };
  }
  return { lastMessagePreview: '', lastMessageRoutine: null };
}
