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

const INJECTED_DISPLAY_BLOCK_TAGS = Object.freeze([
  'system-reminder',
  'available-deferred-tools',
  'mcp-instructions',
  'memory-context',
  'event',
]);

const SYNTHETIC_SESSION_TEXT_PATTERNS = Object.freeze([
  /^\[mixdog-runtime\]/i,
  /^\[(?:truncated|request interrupted by user)\]$/i,
  /^a previous model worked on this task and produced the compacted handoff summary below\b/i,
  /^the async (?:agent|shell) task\b/i,
]);

export function stripSessionDisplayEnvelope(value) {
  return String(value ?? '')
    .replace(/^# Session\r?\n(?:(?:Cwd|Model|Workflow):[^\r\n]*(?:\r?\n|$))+(?:\r?\n)?/i, '')
    .replace(/^#\s*Session\s+Cwd:\s+.*?\s+Model:\s+.*?\s+Workflow:\s+\S+\s*/i, '')
    .replace(/^#\s*Session\s+Cwd:\s+\S+(?:\s+Model:\s+\S*)?(?:\s+Workflow:\s+\S*)?\s*/i, '');
}

export function stripInjectedSessionText(value) {
  let text = String(value ?? '');
  for (const tag of INJECTED_DISPLAY_BLOCK_TAGS) {
    const block = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi');
    const closing = new RegExp(`<\\/${tag}\\s*>`, 'gi');
    text = text.replace(block, ' ').replace(closing, ' ');
  }
  return text;
}

export function isSyntheticSessionText(text) {
  const value = String(text || '').trim();
  return SYNTHETIC_SESSION_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

export function isSessionPreviewNoise(text) {
  const value = String(text || '').trim();
  return !value
    || isSyntheticSessionText(value)
    || !cleanSessionPreview(value)
    || isLateToolAnnouncement(value)
    || /^#\s*permission\b/i.test(value)
    || /^permission:\s*/i.test(value)
    || /^cwd:\s*/i.test(value);
}

export function cleanSessionPreview(text, max = 160) {
  const limit = Math.max(16, Number(max) || 160);
  return stripInjectedSessionText(stripSessionDisplayEnvelope(text))
    .replace(/\[(?:Pasted text|Image)\s*#?\d+(?:\s*(?::[^\]\r\n]*|\+\d+\s+lines))?\]/gi, ' ')
    .replace(/^Reference files:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

// Stable sentinel carried in every late-tool (deferred MCP) announcement
// reminder — must stay byte-identical to LATE_TOOL_REMINDER_SENTINEL in
// src/session-runtime/tool-catalog.mjs. Detection keys on this exact string
// (never fuzzy matching) so the raw announcement block can be hidden from
// user-facing surfaces while the model context stays untouched.
export const LATE_TOOL_ANNOUNCEMENT_SENTINEL = 'connected after this session started';

export function isLateToolAnnouncement(text) {
  const value = String(text || '');
  return value.includes(LATE_TOOL_ANNOUNCEMENT_SENTINEL)
    && /<available-deferred-tools>/i.test(value);
}

// Derive a muted one-line notice from a late-tool announcement body, e.g.
// "MCP tools available: UnityMCP (12 tools)". MCP tool entries in the manifest
// are `- mcp__<server>__<tool>: ...` lines; the server name is the segment
// after the `mcp__` prefix. Returns '' for non-announcement text.
export function summarizeLateToolAnnouncement(text) {
  const value = String(text || '');
  if (!isLateToolAnnouncement(value)) return '';
  const block = value.match(/<available-deferred-tools>([\s\S]*?)<\/available-deferred-tools>/i);
  const body = block ? block[1] : value;
  const names = [];
  const lineRe = /^\s*-\s+([A-Za-z0-9_.:-]+)/gm;
  let m;
  while ((m = lineRe.exec(body))) names.push(m[1]);
  const servers = new Set();
  for (const name of names) {
    const seg = name.startsWith('mcp__') ? name.slice(5) : name;
    const server = seg.split('__')[0];
    if (server) servers.add(server);
  }
  const count = names.length;
  const label = servers.size === 1
    ? [...servers][0]
    : (servers.size ? `${servers.size} MCP servers` : 'MCP');
  if (!count) return `MCP tools available: ${label}`;
  return `MCP tools available: ${label} (${count} ${count === 1 ? 'tool' : 'tools'})`;
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
