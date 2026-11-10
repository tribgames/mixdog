// The tail reminder (session/tail-reminder-rules.mjs) rides the outgoing request
// as its last message, marked meta.source 'tail-reminder'. A provider builder
// that keeps per-message state (cache breakpoints, message counts, continuation
// indexes, tool-loop closure) lifts it off first with splitTailReminder, builds
// from the real history, and then places it in one of two modes:
//
// - Legacy (default, every provider): the reminder is the final wire element
//   (Anthropic: a text block on the last user message) and is never sent again,
//   so the next request's history no longer holds it. That rewrites what came
//   before the assistant turn it produced; Anthropic then drops that turn's
//   thinking (prefix_binding_mismatch).
// - Turn-scoped (append-only): the request ends with a turn-scoped system
//   message ({role:'system', clear_at:'next_user_message'}), and every later
//   request re-sends it byte-identically right before the assistant turn it
//   produced. send-with-recovery stores the reminder on that assistant message
//   (`turnReminder`, all providers), so the wire only ever grows.
//
// Opting in is per provider builder: decide with a capability predicate
// (Anthropic: anthropicTurnScopedReminders in anthropic-request-utils.mjs —
// first-party Messages routes on a supported model),
// re-emit stored `turnReminder`s from the lowered history and append the
// current one in the same shape, both by one placement rule: a request whose
// tail cannot take the message gets no reminder, and replay skips that turn. Builders that have not opted in ignore `turnReminder` and keep
// the legacy layout; a stored reminder never reaches their wire.
export const TAIL_REMINDER_META = 'tail-reminder';

export function splitTailReminder(messages) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  if (last?.role !== 'user' || last.meta?.source !== TAIL_REMINDER_META) return { messages, reminder: '' };
  return { messages: messages.slice(0, -1), reminder: String(last.content || '') };
}
