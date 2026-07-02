// Session message/preview text helpers. Pure, no runtime-closure deps.

export function sessionMessageText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content)
    ? content
    : (content && typeof content === 'object' && Array.isArray(content.content) ? content.content : null);
  if (parts) {
    return parts.map((part) => {
      if (typeof part === 'string') return part;
      return part?.text ?? '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
}

export function messageContextText(message) {
  if (!message || typeof message !== 'object') return '';
  let text = sessionMessageText(message.content);
  if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
    try { text += `\n${JSON.stringify(message.toolCalls)}`; }
    catch { text += `\n[${message.toolCalls.length} tool calls]`; }
  }
  if (message.role === 'tool' && message.toolCallId) text += `\n${message.toolCallId}`;
  return text;
}

export function isSessionPreviewNoise(text) {
  const value = String(text || '').trim();
  return !value
    || value.startsWith('<system-reminder>')
    || value.startsWith('</system-reminder>')
    || /^#\s*permission\b/i.test(value)
    || /^permission:\s*/i.test(value)
    || /^cwd:\s*/i.test(value);
}

export function cleanSessionPreview(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function clean(value) {
  return String(value ?? '').trim();
}

export function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

export function toolResponseText(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result.content
      .map((part) => (part?.type === 'text' ? part.text || '' : JSON.stringify(part)))
      .join('\n');
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

export function isEmptyRecallText(value) {
  const text = String(value || '').trim();
  return !text || /^\(?no results\)?$/i.test(text) || /^\(?empty memory result\)?$/i.test(text);
}

export function currentSessionRecallRows(session, query, { limit = 10 } = {}) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  if (!messages.length) return '(no results)';
  const terms = [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) || [])]
    .filter(Boolean)
    .slice(0, 16);
  const max = Math.max(1, Math.min(100, Number(limit) || 10));
  const rows = [];
  for (let i = messages.length - 1; i >= 0 && rows.length < max; i -= 1) {
    const m = messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool')) continue;
    const text = messageContextText(m).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (terms.length && !terms.some((term) => text.toLowerCase().includes(term))) continue;
    rows.push(`[session:${i + 1}] ${m.role}: ${text.slice(0, 1000)}`);
  }
  return rows.length ? rows.join('\n') : '(no results)';
}

export function sessionHasConversationMessages(activeSession) {
  const messages = Array.isArray(activeSession?.messages) ? activeSession.messages : [];
  return messages.some((message) => {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') return false;
    const text = sessionMessageText(message.content).trim();
    if (!text && role !== 'assistant') return false;
    if (role === 'user' && isSessionPreviewNoise(text)) return false;
    return true;
  });
}
