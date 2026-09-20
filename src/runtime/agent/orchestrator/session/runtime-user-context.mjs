// Only producer-owned boundaries are removable. Matching tag names inside
// user text (including old transcripts without provenance) are not ownership.
export function withRuntimeUserContext(message, { prefix = '', suffix = '' } = {}) {
  if (!prefix && !suffix) return message;
  const textBlock = (text) => (text ? [{ type: 'text', text }] : []);
  const content = Array.isArray(message.content)
    ? [...textBlock(prefix), ...message.content, ...textBlock(suffix)]
    : `${prefix}${message.content}${suffix}`;
  return {
    ...message,
    content,
    meta: { ...message.meta, runtimeUserContext: { prefix, suffix } },
  };
}

export function stripRuntimeUserContext(message) {
  const context = message?.role === 'user' ? message.meta?.runtimeUserContext : null;
  if (!context || typeof context.prefix !== 'string' || typeof context.suffix !== 'string') return message;
  const { prefix, suffix } = context;
  let content = message.content;
  if (typeof content === 'string') {
    if (content.length < prefix.length + suffix.length || !content.startsWith(prefix) || !content.endsWith(suffix)) {
      return message;
    }
    content = content.slice(prefix.length, content.length - suffix.length);
  } else if (Array.isArray(content)) {
    // The producer adds separate text blocks, leaving media and user blocks
    // untouched. Refuse stale provenance rather than guessing new boundaries.
    if (prefix && (content[0]?.type !== 'text' || content[0].text !== prefix)) return message;
    if (suffix && (content.at(-1)?.type !== 'text' || content.at(-1).text !== suffix)) return message;
    if (content.length < Number(Boolean(prefix)) + Number(Boolean(suffix))) return message;
    content = content.slice(prefix ? 1 : 0, content.length - (suffix ? 1 : 0));
  } else {
    return message;
  }
  const { runtimeUserContext: _context, ...meta } = message.meta;
  const result = { ...message, content, meta };
  if (Object.keys(meta).length === 0) delete result.meta;
  return result;
}
