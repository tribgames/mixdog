// A bot row's unread pill counts the chat messages that arrived since the read
// cursor, not the raw `messageCount` growth (every tool call and tool result
// is a counted message). The catalog row carries `incomingTail`: the places,
// among the counted messages, of the last incoming messages with text
// (assistant replies and posted results; never the user's own prompts, tool
// calls or tool results). The read cursor keeps its raw numbering, so desktop,
// the paired phone and every older cursor read it unchanged.

/** The tail as a clean list of whole places, or undefined for anything else. */
export function cleanIncomingTail(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // One past the pill's 99, matching the runtime's INCOMING_TAIL_MAX, so a full tail reads "99+".
  return value.filter((place): place is number => Number.isSafeInteger(place) && place > 0).slice(-100);
}

/** Messages that arrived past the read cursor, at least 1: a row without a
 *  tail (an older catalog row, or one read off a session file) shows one. */
export function unseenIncomingCount(row: { readMessageCount?: number; incomingTail?: readonly number[] }): number {
  if (!row.incomingTail) return 1;
  const read = Number(row.readMessageCount) || 0;
  return Math.max(1, row.incomingTail.filter((place) => place > read).length);
}
