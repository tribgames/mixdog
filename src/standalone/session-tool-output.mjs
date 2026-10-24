import { encodeCatalogCursor } from '../runtime/agent/orchestrator/session/catalog-db/schema.mjs';
import { UNTRUSTED_NOTE, sessionBotOf } from '../session-runtime/bot-status.mjs';
import { escapeHarnessTags } from '../runtime/shared/shell-output-summary.mjs';
import { truncateToolText } from '../runtime/shared/tool-primitives.mjs';
import { summarizeToolResult } from '../runtime/shared/tool-result-summary.mjs';

import { TOOL_OUTPUT_PAGE_BYTES, TOOL_OUTPUT_TAIL_BYTES } from '../runtime/shared/tool-output-budget.mjs';

export const SESSION_TOOL_OUTPUT_BYTES = TOOL_OUTPUT_TAIL_BYTES;
const MESSAGE_TEXT_LIMIT = 2000;
const LIST_PREVIEW_LIMIT = 100;
const outputBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Keep catalog paging authoritative even when the output budget shortens a page.
 *  `rich` adds the owning bot, last activity, latest line and working state
 *  (never for a background caller: bot-status.mjs scopedBot). `rich` may be a
 *  per-row predicate: a bot gets them only for its own sessions. */
export function sessionListOutput(page, limit, { rich = true } = {}) {
  const raw = page.sessions;
  const sessions = raw.slice(0, limit).map((row) => {
    // Decided first: a session that is not the caller's carries its real
    // title only, never a preview standing in for it.
    const own = typeof rich === 'function' ? rich(row) : rich;
    const title = own ? row.title || row.preview : row.title;
    const base = {
      id: row.id,
      ...(title ? { title: escapeHarnessTags(truncateToolText(title, 160)) } : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.archived === true ? { archived: true } : {}),
    };
    if (!own) return base;
    // The bot it belongs to: its chat, room seat or the task's creator.
    const bot = sessionBotOf(row);
    const lastUsedAt = Number(row.lastUsedAt) || 0;
    const preview = String(row.lastMessagePreview || '').replace(/\s+/g, ' ');
    return {
      ...base,
      ...(bot ? { bot } : {}),
      ...(lastUsedAt ? { lastUsedAt: new Date(lastUsedAt).toISOString() } : {}),
      // The latest user or assistant line, quoted data.
      ...(preview.trim() ? { preview: escapeHarnessTags(truncateToolText(preview, LIST_PREVIEW_LIMIT)) } : {}),
      ...(row.working === true || row.agentWorking === true ? { working: true } : {}),
    };
  });
  const result = {
    sessions,
    nextCursor: page.nextCursor ?? null,
    ...(sessions.some((row) => row.preview) ? { note: UNTRUSTED_NOTE } : {}),
  };
  for (;;) {
    if (sessions.length < raw.length && sessions.length) {
      result.nextCursor = encodeCatalogCursor(raw[sessions.length - 1]);
    }
    if (outputBytes(result) <= TOOL_OUTPUT_PAGE_BYTES) return result;
    if (sessions.length <= 1) throw new Error('session: one catalog row exceeds the output budget');
    sessions.pop();
  }
}

function conversationItem(item, offset, textOffset) {
  const row = { kind: item.kind, offset, ...(item.id != null ? { id: item.id } : {}) };
  if (item.name) row.name = item.name;
  if (item.status) row.status = item.status;
  if (item.isError === true) row.isError = true;
  let text = item.text || item.detail || item.label || '';
  if (item.kind === 'tool') {
    const value = item.rawResult ?? item.result ?? '';
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    text = raw || summarizeToolResult(item.name, item.args, raw, item.isError === true) || text;
  }
  if (text) {
    // Conversation indentation is significant; do not trim code/prose like a title.
    if (
      textOffset > 0 &&
      /[\uDC00-\uDFFF]/.test(text[textOffset] || '') &&
      /[\uD800-\uDBFF]/.test(text[textOffset - 1])
    )
      throw new Error('session: text_offset splits a surrogate pair');
    let end = Math.min(text.length, textOffset + MESSAGE_TEXT_LIMIT);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    row.text = text.slice(textOffset, end);
    if (end < text.length) row.nextTextOffset = end;
  }
  const attachments = item.attachments ?? item.imageRefs ?? item.images;
  if (attachments?.length) row.attachments = attachments.length;
  return row;
}

/** Service windows can be sticky/shared; enforce this tool call's limits locally. */
export function sessionReadOutput(sessionId, range, { textOffset = 0, itemId } = {}) {
  const byteLimit = range.offset === 0 && textOffset === 0 ? TOOL_OUTPUT_TAIL_BYTES : TOOL_OUTPUT_PAGE_BYTES;
  const source = range.items;
  if (itemId !== undefined && (source.length !== 1 || source[0].id !== itemId)) {
    throw new Error('session: stale item position; read the tail again');
  }
  const items = source.map((item, index) =>
    conversationItem(item, range.offset + source.length - index - 1, textOffset)
  );
  const result = {
    sessionId,
    offset: range.offset,
    items,
    nextOffset: null,
  };
  for (;;) {
    result.nextOffset = range.hasOlder || items.length < source.length ? range.offset + items.length : null;
    if (outputBytes(result) <= byteLimit) return result;
    if (items.length <= 1) throw new Error('session: one transcript item exceeds the output budget');
    items.shift();
  }
}
