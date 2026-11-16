// Recovery for an assistant turn whose stored replay blocks the API refuses.
//
// Anthropic validates thinking replay against the conversation prefix that
// produced it, not just the newest assistant message. A stale signature or an
// empty text block is rejected deterministically — and because the transcript
// is already persisted, every retry rebuilds the same body unless it is repaired.
//
// The repair is the one the API documents as safe: drop opaque reasoning replay
// from the transcript because a wire-message index cannot safely identify its
// persisted row after provider lowering. Keep text and tool calls; reasoning
// replay is an optimization, while decisions live in the text/tool_use blocks.
import { assistantMessageWithoutThinkingReplay, rebindToChangedPrefix } from './thinking-binding.mjs';
import { errorHttpStatus as errorStatus } from '../../../shared/err-text.mjs';

export { assistantMessageWithoutThinkingReplay };

function errorText(err) {
  const detail = err?.providerError || err?.responseFailed?.response?.error || null;
  return `${detail?.message || ''} ${err?.message || ''}`;
}

/**
 * True for the deterministic 400s that a replay repair can actually clear.
 * "must start with a thinking block" is deliberately absent: stripping is the
 * wrong move there — that error asks for MORE reasoning replay, not less.
 */
export function isThinkingReplayRejection(err) {
  if (!err || typeof err !== 'object') return false;
  if (errorStatus(err) !== 400) return false;
  const text = errorText(err);
  return (
    /blocks in the latest assistant message cannot be modified/i.test(text) ||
    /text content blocks must be non-empty/i.test(text) ||
    /bound to a different conversation/i.test(text) ||
    /invalid\s+[`'"]?signature[`'"]?\s+in\s+[`'"]?thinking[`'"]?\s+block/i.test(text)
  );
}

/** The newest assistant turn that still carries replay blocks a repair would
 *  drop, with its repaired copy; null when there is none. */
function newestRepairableAssistant(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const repaired = assistantMessageWithoutThinkingReplay(message);
    if (repaired) return { index, repaired };
  }
  return null;
}

/** Whether any assistant turn still carries replay blocks a repair would drop. */
export function canRepairThinkingReplay(messages) {
  return newestRepairableAssistant(messages) !== null;
}

/**
 * Repair all thinking replay made stale by a prefix mismatch, in place, so
 * the fix is persisted with the session. A trailing open tool round is closed
 * before stripping, so it cannot be resumed without the thinking it requires.
 * Returns the first repaired assistant index, or -1 when nothing matched.
 */
export function repairThinkingReplayInPlace(messages) {
  if (!Array.isArray(messages) || !canRepairThinkingReplay(messages)) return -1;
  const original = messages.slice();
  const repaired = rebindToChangedPrefix(messages);
  const repairedIndex = original.findIndex((message, index) => message !== repaired[index]);
  if (repaired === messages || repairedIndex < 0) return -1;
  // Replace references rather than editing messages: the session store's
  // delta writer persists the replay-free copies, plus any round-closing turn.
  for (let index = 0; index < repaired.length; index += 1) messages[index] = repaired[index];
  messages.length = repaired.length;
  return repairedIndex;
}
