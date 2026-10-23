/**
 * Stable per-message identity: `meta.transcript.messageId`.
 *
 * Prompts and replies get theirs at creation (shared/transcript-metadata.mjs).
 * Every other message — tool calls and results, injected rows, legacy
 * transcripts — is stamped before a compaction runs or a stored session is
 * resumed (stampMessageIds), and every compaction rewrite carries the id of
 * the message it rewrites to its copy (spread copies keep `meta`;
 * constructed copies use carryMessageId). A compaction's dropped messages
 * are then exactly the ids its result no longer holds.
 *
 * A message whose `meta` is a string marker ('skill', 'hook': injected
 * model context that is never displayed) cannot carry an id without changing
 * what that marker means; it stays unstamped and has no display identity.
 *
 * Leaf module: no store, no config.
 */
import { createHash } from 'node:crypto';

/** The message's stable id, or ''. */
export function messageIdOf(message) {
  const meta = message?.meta;
  if (!meta || typeof meta !== 'object') return '';
  const id = meta.transcript?.messageId;
  return typeof id === 'string' ? id : '';
}

/** Whether `meta` can hold a transcript id (absent or a plain object). */
export function canCarryMessageId(message) {
  if (!message || typeof message !== 'object') return false;
  const meta = message.meta;
  return meta === undefined || meta === null || (typeof meta === 'object' && !Array.isArray(meta));
}

function withMessageId(meta, messageId) {
  const base = meta && typeof meta === 'object' ? meta : {};
  const transcript = base.transcript && typeof base.transcript === 'object' ? base.transcript : {};
  return { ...base, transcript: { ...transcript, messageId } };
}

// A deterministic seed: the same unstamped transcript gets the same ids on
// every stamping (a legacy session reopened twice before its stamps are
// saved keeps them; two compactions of one transcript agree). The content
// part is bounded — its length and edges, media by kind and size — so
// stamping never serializes whole images or documents. The position keeps
// equal messages apart.
const SEED_EDGE_CHARS = 512;
function boundedText(value) {
  const text = String(value);
  if (text.length <= SEED_EDGE_CHARS * 2) return text;
  return `${text.slice(0, SEED_EDGE_CHARS)}\u0000${text.length}\u0000${text.slice(-SEED_EDGE_CHARS)}`;
}
function boundedContent(content) {
  if (typeof content === 'string') return boundedText(content);
  if (!Array.isArray(content)) return content == null ? '' : typeof content;
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return String(part);
      if (typeof part.text === 'string') return `t:${boundedText(part.text)}`;
      const data = part.data ?? part.source?.data ?? part.image_url?.url ?? part.url ?? part.ref ?? '';
      return `${part.type || 'part'}:${typeof data === 'string' ? data.length : 0}`;
    })
    .join('\u0001');
}
function seededMessageId(sessionId, index, message) {
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : message.tool_calls;
  const callIds = Array.isArray(calls) ? calls.map((call) => call?.id || '').join(',') : '';
  const seed = [
    sessionId,
    index,
    message.role,
    message.toolCallId || message.tool_call_id || '',
    callIds,
    boundedContent(message.content),
  ].join('\u0002');
  return `msg_${createHash('sha1').update(seed).digest('hex').slice(0, 32)}`;
}

/** Stamp a stable id on every message that can carry one and has none, in
 *  place. Returns how many were stamped (the caller persists them). */
export function stampMessageIds(messages, { sessionId = '' } = {}) {
  if (!Array.isArray(messages)) return 0;
  let stamped = 0;
  const seen = new Set();
  messages.forEach((message, index) => {
    const existing = messageIdOf(message);
    if (existing) {
      seen.add(existing);
      return;
    }
    if (!canCarryMessageId(message)) return;
    let id = seededMessageId(String(sessionId || ''), index, message);
    // Never two messages with one id within a transcript.
    for (let salt = 1; seen.has(id); salt += 1) id = seededMessageId(`${sessionId}#${salt}`, index, message);
    seen.add(id);
    message.meta = withMessageId(message.meta, id);
    stamped += 1;
  });
  return stamped;
}

/** JSON.stringify replacer that leaves stable ids out: hashes and archives
 *  the compactor derives from message JSON describe the conversation, not
 *  its display bookkeeping (a meta that only held the id is left out too).
 *  Reactions on a message (message-reactions.mjs) are display bookkeeping of
 *  the same kind, written in place mid-turn, and are left out with the id. */
export function withoutMessageIdsReplacer(key, value) {
  if (key !== 'meta' || !value || typeof value !== 'object' || typeof value.transcript?.messageId !== 'string') {
    return value;
  }
  const { messageId: _id, reactions: _reactions, ...transcript } = value.transcript;
  const meta = { ...value };
  if (Object.keys(transcript).length) meta.transcript = transcript;
  else delete meta.transcript;
  return Object.keys(meta).length ? meta : undefined;
}

/** `copy` carrying the stable id of `original` (a compaction rewrite that
 *  builds a new message instead of spreading the original). Only the id
 *  travels; the copy's own meta is kept. */
export function carryMessageId(copy, original) {
  const id = messageIdOf(original);
  if (!id || !canCarryMessageId(copy) || messageIdOf(copy) === id) return copy;
  return { ...copy, meta: withMessageId(copy.meta, id) };
}
