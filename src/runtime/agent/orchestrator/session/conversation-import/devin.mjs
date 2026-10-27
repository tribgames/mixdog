/**
 * Devin CLI snapshot lines → raw turns. A snapshot is a materialized export
 * of Devin's SQLite session store (session-runtime/conversation-import/
 * devin-store.mjs): one `session_meta` line carrying the session row, then
 * `node` lines in node_id order — the store's chronological order, one row
 * per message node. Each node's `chat_message` is the Devin shape
 * {role, content, tool_calls, metadata} with string content.
 *
 * Kept: user messages flagged `metadata.is_user_input` (the rest are Devin's
 * internal cache-keepalive/compaction envelopes) and assistant text, with
 * `tool_calls` as `[ran tool: <name>]` notes. Dropped: system, tool-result
 * and thinking content, so message order and speakers are preserved.
 */
import { textPart, timestampMs, toolNote } from './turns.mjs';

const ENTRY_OVERHEAD_BYTES = 64;
const stringOrNull = (value) => (typeof value === 'string' && value.trim() ? value : null);
const nodeAt = (payload) =>
  typeof payload?.created_at === 'number' && payload.created_at > 0 ? timestampMs(payload.created_at * 1000) : null;

const toolName = (call) => stringOrNull(call?.function?.name) || stringOrNull(call?.name) || null;

export function createDevinReducer() {
  const rawTurns = [];
  // Each turn is its own chain, so context messages re-appear as later nodes
  // under the same message_id. The first node's position stays; its parts are
  // replaced by a fuller copy when a later chain carries one.
  const seen = new Map();
  const warnings = new Set();
  let recognized = false;
  let foreignSessionId = null;
  let cwd = null;
  let storedTitle = null;
  let chars = 0;
  let metadataBytes = 0;
  const partsChars = (parts) => parts.reduce((total, part) => total + part.text.length, 0);
  return {
    get chars() {
      return chars;
    },
    get entries() {
      return rawTurns.length;
    },
    get metadataBytes() {
      return metadataBytes;
    },
    push(record) {
      if (record?.type === 'session_meta') {
        recognized = true;
        const payload = record.payload && typeof record.payload === 'object' ? record.payload : null;
        foreignSessionId ||= stringOrNull(payload?.id);
        cwd ||= stringOrNull(payload?.cwd);
        storedTitle ||= stringOrNull(payload?.title);
        metadataBytes += ENTRY_OVERHEAD_BYTES;
        return;
      }
      if (record?.type !== 'node') return;
      recognized = true;
      const payload = record.payload && typeof record.payload === 'object' ? record.payload : null;
      const message = payload?.chat_message;
      if (!message || typeof message !== 'object') return;
      metadataBytes += ENTRY_OVERHEAD_BYTES;
      const keep = (parts) => {
        if (!parts.length) return;
        const kept = partsChars(parts);
        const mid = stringOrNull(message.message_id);
        const key = mid ? `${message.role}:${mid}` : null;
        if (key && seen.has(key)) {
          const turn = rawTurns[seen.get(key)];
          const replaced = partsChars(turn.parts);
          if (kept > replaced) {
            chars += kept - replaced;
            turn.parts = parts;
          }
          return;
        }
        if (key) seen.set(key, rawTurns.length);
        chars += kept;
        rawTurns.push({ role: message.role, parts, at: nodeAt(payload) });
      };
      if (message.role === 'user') {
        if (message.metadata?.is_user_input !== true) return;
        const text = stringOrNull(message.content);
        if (text) keep([textPart(text)]);
        return;
      }
      if (message.role === 'assistant') {
        const parts = [];
        const text = stringOrNull(message.content);
        if (text) parts.push(textPart(text));
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        for (const call of calls) parts.push(toolNote(toolName(call)));
        keep(parts);
      }
      // system prompts and tool results are never conversation turns.
    },
    result() {
      return { recognized, foreignSessionId, cwd, storedTitle, rawTurns, warnings };
    },
  };
}
