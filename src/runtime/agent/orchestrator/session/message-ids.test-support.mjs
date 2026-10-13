// Tests that compare a transcript before and after a compaction: compaction
// stamps stable ids (message-ids.mjs) on messages that had none, which is
// bookkeeping, not a change of the conversation.

/** `messages` without the stable ids stamped on them (and without the meta a
 *  stamp alone created). */
export function withoutStampedIds(messages) {
  return messages.map((message) => {
    const transcript = message?.meta?.transcript;
    if (!transcript?.messageId) return message;
    const { messageId: _id, ...rest } = transcript;
    const meta = { ...message.meta };
    if (Object.keys(rest).length) meta.transcript = rest;
    else delete meta.transcript;
    const out = { ...message };
    if (Object.keys(meta).length) out.meta = meta;
    else delete out.meta;
    return out;
  });
}

/** Whether every message that can carry an id has one. */
export function everyMessageStamped(messages) {
  return messages.every(
    (message) =>
      (message?.meta !== undefined && (typeof message.meta !== 'object' || message.meta === null)) ||
      typeof message?.meta?.transcript?.messageId === 'string'
  );
}
