// The tail reminder (session/tail-reminder-rules.mjs) rides the outgoing request
// as its last message, marked meta.source 'tail-reminder'. It is ephemeral: a
// provider builder that keeps per-message state (cache breakpoints, message
// counts, continuation indexes, tool-loop closure) lifts it off first with
// splitTailReminder, builds from the real history, and appends the reminder as
// the final wire element, so the history-derived prefix never contains it.
export const TAIL_REMINDER_META = 'tail-reminder';

export function splitTailReminder(messages) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  if (last?.role !== 'user' || last.meta?.source !== TAIL_REMINDER_META) return { messages, reminder: '' };
  return { messages: messages.slice(0, -1), reminder: String(last.content || '') };
}
