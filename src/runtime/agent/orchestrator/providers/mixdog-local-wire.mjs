// llama.cpp templates accept one system message at position zero. Keep the
// session's cache-tier layout untouched; normalize only the local wire copy.
function instructionText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content) && content.every((part) => part?.type === 'text' && typeof part.text === 'string')) {
    return content.map((part) => part.text).join('\n\n');
  }
  throw new TypeError('Local Provider system instructions must contain text only.');
}

export function toLocalProviderMessages(messages) {
  const instructions = [];
  const conversation = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      instructions.push(instructionText(message.content));
    } else {
      conversation.push(message);
    }
  }
  return instructions.length
    ? [{ role: 'system', content: instructions.join('\n\n') }, ...conversation]
    : conversation;
}
