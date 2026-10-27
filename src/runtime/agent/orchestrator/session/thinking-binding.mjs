// Thinking replay is bound to the request prefix that produced it.
//
// An Anthropic thinking block's signature records the conversation prefix it
// was generated under: the top-level system prompt, the tool set, and every
// earlier message. A request whose system or tools changed since then carries
// blocks the API drops before the model sees them (unbilled, so the provider's
// count no longer includes them) or, where the check is enforced, refuses with
// a 400. The drop also takes every LATER thinking block, so a transcript that
// keeps the stale blocks loses the reasoning of every turn that follows them.
//
// Where the runtime itself changes that prefix — a heir carrying a conversation
// into a prompt built for it, a folded or migrated prompt — the stored thinking
// can never be replayed again. It is stripped once, at that boundary, the
// documented recovery: each turn keeps its text and tool calls, and the next
// turns' thinking binds to the new prefix and is replayed normally. Leaving it
// in place also kept charging every signature to the local context estimate,
// which then ran far above what the provider actually counted.
//
// One round is never stripped: a trailing tool round whose next request still
// continues it (the latest assistant turn called tools and no final reply
// followed — an idle session can stop there after a provider error). Its
// latest assistant turn must go back starting with its thinking, so removing
// that thinking is a refused request too. When the prefix changed under such a
// round, the round is ended explicitly instead (`rebindToChangedPrefix`).
import { contextAckMessage } from './compact/user-message-kind.mjs';
import { collectAssistantToolCallIds } from './context-tool-pairs.mjs';
import { assistantMessageWithoutThinkingReplay } from './thinking-replay-recovery.mjs';

/** The runtime turn that ends an open tool round: a context ack, so the
 *  transcript never shows it and Compact never reads it as a reply. */
function toolRoundClosure() {
  const ack = contextAckMessage();
  return { ...ack, meta: { ...ack.meta, synthetic: true } };
}

const callsTools = (message) =>
  collectAssistantToolCallIds(message).length > 0 ||
  (Array.isArray(message?.providerReplay?.items) &&
    message.providerReplay.items.some((item) => item?.type === 'tool_use'));

/**
 * Index where the trailing open tool round starts (the assistant/tool run that
 * ends with the latest assistant turn's results; later user or notification
 * input may follow), or -1 when the latest assistant turn is a final reply.
 * Read from the persisted transcript alone.
 */
export function openToolRoundStart(messages) {
  if (!Array.isArray(messages)) return -1;
  const latest = messages.findLastIndex((message) => message?.role === 'assistant');
  if (latest < 0 || !callsTools(messages[latest])) return -1;
  let start = latest;
  while (start > 0 && ['assistant', 'tool'].includes(messages[start - 1]?.role)) start -= 1;
  return start;
}

/** What the next request sends ahead of the conversation: the system blocks and tools. */
export function requestPrefixIdentity(session) {
  return JSON.stringify([
    (Array.isArray(session?.messages) ? session.messages : [])
      .filter((message) => message?.role === 'system')
      .map((message) => message.content),
    session?.tools,
  ]);
}

/**
 * `messages` without Anthropic thinking replay (thinking / redacted_thinking
 * blocks, wherever an assistant turn stores them); text and tool calls stay.
 * The trailing open tool round keeps its thinking: everything stripped is a
 * leading run, which leaves the round's own blocks valid.
 * Replaces changed messages, never mutates; the same array when none changed.
 */
export function withoutThinkingReplay(messages) {
  if (!Array.isArray(messages)) return messages;
  const open = openToolRoundStart(messages);
  const end = open < 0 ? messages.length : open;
  let changed = false;
  const out = messages.map((message, index) => {
    const stripped = index < end ? assistantMessageWithoutThinkingReplay(message) : null;
    if (!stripped) return message;
    changed = true;
    return stripped;
  });
  return changed ? out : messages;
}

/**
 * `messages` for a request prefix that changed under them: no thinking replay
 * at all. An open tool round that carries thinking can neither keep it (bound
 * to the old prefix) nor lose it (its continuation must start with it), so it
 * is ended first by a runtime turn right after its last tool result, ahead of
 * any later input (a task notification stays pending after it); the next
 * request then starts a new turn. Never mutates; the same array when nothing
 * changed.
 */
export function rebindToChangedPrefix(messages) {
  if (!Array.isArray(messages)) return messages;
  const open = openToolRoundStart(messages);
  if (open < 0) return withoutThinkingReplay(messages);
  let end = messages.findLastIndex((message) => message?.role === 'assistant') + 1;
  while (messages[end]?.role === 'tool') end += 1;
  const roundThinks = messages
    .slice(open, end)
    .some((message) => assistantMessageWithoutThinkingReplay(message) !== null);
  return withoutThinkingReplay(
    roundThinks ? [...messages.slice(0, end), toolRoundClosure(), ...messages.slice(end)] : messages
  );
}
