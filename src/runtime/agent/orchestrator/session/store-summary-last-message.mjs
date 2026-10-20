/**
 * The summary's last-message line (a messenger row's preview): the newest
 * user or assistant message with displayable text, and that line's routine
 * provenance. Leaf module, shared by the summary index (store saves) and the
 * catalog's strict file scan so both derive the same line.
 */
import { cleanSessionPreview, isSessionPreviewNoise, sessionMessageText } from '../runtime-core/session-text.mjs';
import { plainPreviewText } from '../../../shared/plain-preview.mjs';
import { isRoutineResultMessage, routineProvenance, routineResultNotice } from './routine-result.mjs';

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

/** The message's last-message line, '' when it has none (tool-only, synthetic). */
export function lastMessageLine(message) {
  const raw = lastMessageRawText(message);
  if (raw === null || isSessionPreviewNoise(raw)) return '';
  return cleanSummaryPreview(plainPreviewText(raw), LAST_MESSAGE_PREVIEW_MAX);
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
