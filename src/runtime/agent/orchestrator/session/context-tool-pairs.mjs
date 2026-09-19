// Tool call/result pairing repairs on a message list: missing-result stubs,
// duplicate-body dedup and Anthropic content pairing.
import { isOffloadedToolResultText } from './tool-result-offload.mjs';
import { createHash } from 'node:crypto';

const TOOL_MISSING_STUB = '[Older tool result unavailable after context compaction]';
function collectAssistantToolCallIds(message) {
  if (message?.role !== 'assistant') return [];
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  if (Array.isArray(message.toolCalls)) {
    for (const tc of message.toolCalls) add(tc?.id);
  }
  const blocksFrom = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (b?.type === 'tool_use' && b.id) add(b.id);
    }
  };
  blocksFrom(message.assistantBlocks);
  blocksFrom(message.content);
  return ids;
}
/**
 * Tool-pair sanitization (unmatched tool_use / tool_result repair):
 *   - Drop malformed `tool` messages without toolCallId.
 *   - Drop `tool` messages whose toolCallId has no surviving assistant tool_call.
 *   - For each surviving assistant tool_call, reattach the matching `tool`
 *     message (if any) immediately after that assistant; duplicate ids prefer
 *     the contiguous post-assistant block, then later matches, then earlier.
 *   - For tool_calls with no matching result, insert a stub tool message so
 *     the provider doesn't reject the request for unmatched tool_use_id.
 * Non-tool message order is preserved; tool results are not duplicated.
 */
// The tool result answering `toolCallId`: first in the tool block right after
// the assistant turn, then anywhere later, then anywhere earlier.
function pickToolResultForAssistant(messages, assistantIdx, toolCallId) {
  let i = assistantIdx + 1;
  while (i < messages.length && messages[i]?.role === 'tool') {
    const tm = messages[i];
    if (tm.toolCallId === toolCallId) return tm;
    i += 1;
  }
  let afterBlock = assistantIdx + 1;
  while (afterBlock < messages.length && messages[afterBlock]?.role === 'tool') afterBlock += 1;
  for (let j = afterBlock; j < messages.length; j += 1) {
    const tm = messages[j];
    if (tm?.role === 'tool' && tm.toolCallId === toolCallId) return tm;
  }
  for (let j = 0; j < assistantIdx; j += 1) {
    const tm = messages[j];
    if (tm?.role === 'tool' && tm.toolCallId === toolCallId) return tm;
  }
  return null;
}

export function sanitizeToolPairs(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const placedToolIds = new Set();
  const result = [];
  for (let idx = 0; idx < messages.length; idx += 1) {
    const m = messages[idx];
    // Tool results are only ever placed by the assistant turn that called
    // them; a loose one (orphaned, duplicated or misplaced) is dropped.
    if (m.role === 'tool') continue;
    result.push(m);
    if (m.role !== 'assistant') continue;
    for (const callId of collectAssistantToolCallIds(m)) {
      if (placedToolIds.has(callId)) continue;
      const existing = pickToolResultForAssistant(messages, idx, callId);
      result.push(existing || { role: 'tool', content: TOOL_MISSING_STUB, toolCallId: callId });
      placedToolIds.add(callId);
    }
  }
  return result;
}

// Minimum body size to consider for hash-based dedup. Small results are
// cheap to re-deliver and short strings often collide on trivial content
// like "ok" or "done", so deduplicate only non-trivial bodies.
const DEDUP_MIN_BYTES = 512;

/**
 * Replace duplicate tool-result bodies (2nd+ occurrence of the same content
 * hash) with a compact reference stub. Hash-based dedup avoids re-delivering
 * large identical results (e.g. the same grep output called twice) while
 * keeping the first occurrence intact so the model still has the body.
 *
 * Skip conditions (structural — not heuristic prefix sniffing):
 *   - m.toolKind !== 'normal' (and defined): cache-hit / error / ref messages
 *     carry a structured kind annotation set by loop.mjs; skip them.
 *   - No toolKind (undefined): legacy or intra-turn-dedup stubs — apply dedup
 *     (backward compatible; the dedup body IS the meaningful result).
 *   - content.length < DEDUP_MIN_BYTES: structural cost optimization.
 *   - isOffloadedToolResultText(content): body is on disk, not inline.
 */
export function dedupToolResultBodies(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const seenHash = new Map(); // hash -> first toolCallId
  return messages.map((m) => {
    if (m?.role !== 'tool' || typeof m.content !== 'string') return m;
    const content = m.content;
    if (content.length < DEDUP_MIN_BYTES) return m;
    if (isOffloadedToolResultText(content)) return m;
    // Structural kind-based skip: non-normal kinds are already stubs/refs —
    // deduping them would nest stubs inside stubs and confuse the model.
    if (m.toolKind !== undefined && m.toolKind !== 'normal') return m;
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const first = seenHash.get(hash);
    if (!first) {
      seenHash.set(hash, m.toolCallId || '?');
      return m;
    }
    const stub = `[duplicate-of tool_use_id=${first}] body identical to result of ${first} (sha256 prefix matches; ${content.length} bytes elided).`;
    return { ...m, content: stub };
  });
}

// Match the head of dedupToolResultBodies' stub body so we can detect whether
// the referenced first-occurrence tool_use_id is still present after later
// drop passes (safety loop, sanitize). Any stub pointing at an id no longer
// in the message stream is reconciled back to TOOL_MISSING_STUB so the model
// never sees `[duplicate-of call_X]` with no call_X.
const DEDUP_STUB_HEAD_RE = /^\[duplicate-of tool_use_id=([^\]]+)\]/;
export function reconcileDedupStubs(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const presentIds = new Set();
  for (const m of messages) {
    if (m?.role === 'tool' && m.toolCallId) presentIds.add(m.toolCallId);
  }
  return messages.map((m) => {
    if (m?.role !== 'tool' || typeof m.content !== 'string') return m;
    const match = DEDUP_STUB_HEAD_RE.exec(m.content);
    if (!match) return m;
    if (presentIds.has(match[1])) return m;
    return { ...m, content: TOOL_MISSING_STUB };
  });
}

/**
 * Final-mile pairing for Anthropic API content arrays. Operates on the
 * already-converted format (role: assistant|user|system, content: block[])
 * — the mixdog-internal sanitizeToolPairs only sees toolCalls/toolCallId
 * fields and misses cases where tool_use blocks were pushed directly into
 * content (streaming chunk inserts, salvage paths, etc.). Without this
 * pass, an unmatched tool_use can reach the provider and trigger
 * `messages.N: tool_use ids were found without tool_result blocks
 * immediately after`.
 */
const isUserBlocks = (message) => message?.role === 'user' && Array.isArray(message.content);

function stripOrphanToolResults(userMsg, allowedIds) {
  if (!isUserBlocks(userMsg)) return userMsg;
  const hasToolResults = userMsg.content.some((b) => b?.type === 'tool_result');
  if (!hasToolResults) return userMsg;
  const filtered = userMsg.content.filter((b) => {
    if (b?.type !== 'tool_result') return true;
    if (!b.tool_use_id) return false;
    return allowedIds.size > 0 && allowedIds.has(b.tool_use_id);
  });
  if (filtered.length === userMsg.content.length) return userMsg;
  return { ...userMsg, content: filtered };
}

// Drop tool_use blocks without an id from assistant messages — these
// come from partial streaming chunks that never finalised, and the
// provider rejects them as `tool_use ids were found without
// tool_result blocks` even though no id was actually emitted.
function dropIdlessToolUses(message) {
  const cleaned = message.content.filter((b) => !(b?.type === 'tool_use' && !b.id));
  return cleaned.length === message.content.length ? message : { ...message, content: cleaned };
}

// Error stubs for every tool_use id the following user message does not answer.
function toolResultStubs(toolUseIds, next) {
  const nextResultIds = isUserBlocks(next)
    ? new Set(next.content.filter((b) => b?.type === 'tool_result' && b.tool_use_id).map((b) => b.tool_use_id))
    : new Set();
  return toolUseIds
    .filter((id) => !nextResultIds.has(id))
    .map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: '[tool_result missing — recovered by sanitizeAnthropicContentPairs]',
      is_error: true,
    }));
}

// Anthropic requires tool_result blocks to lead the user message
// when responding to a prior tool_use. Reorder even when no stub
// was needed; a matching tool_result after text still triggers the
// same `tool_use ids ... without tool_result blocks immediately
// after` rejection. The same message when nothing changes.
function leadWithToolResults(next, stubs) {
  const existingResults = next.content.filter((b) => b?.type === 'tool_result');
  const nonResults = next.content.filter((b) => b?.type !== 'tool_result');
  const reordered = [...stubs, ...existingResults, ...nonResults];
  const changed = stubs.length > 0 || reordered.some((b, idx) => b !== next.content[idx]);
  return changed ? { ...next, content: reordered } : next;
}

export function sanitizeAnthropicContentPairs(messages) {
  if (!Array.isArray(messages)) return messages;
  const work = messages.slice();
  const out = [];
  let pendingToolUseIds = new Set();
  for (let i = 0; i < work.length; i++) {
    let m = work[i];
    if (isUserBlocks(m)) {
      const hadToolResults = m.content.some((b) => b?.type === 'tool_result');
      m = stripOrphanToolResults(m, pendingToolUseIds);
      work[i] = m;
      if (hadToolResults) pendingToolUseIds = new Set();
    }
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      m = dropIdlessToolUses(m);
      work[i] = m;
    }
    if (isUserBlocks(m) && m.content.length === 0) continue;
    out.push(m);
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const toolUseIds = m.content.filter((b) => b?.type === 'tool_use' && b.id).map((b) => b.id);
    pendingToolUseIds = new Set(toolUseIds);
    if (toolUseIds.length === 0) continue;
    let next = work[i + 1];
    if (isUserBlocks(next)) {
      next = stripOrphanToolResults(next, pendingToolUseIds);
      work[i + 1] = next;
    }
    const stubs = toolResultStubs(toolUseIds, next);
    if (isUserBlocks(next)) work[i + 1] = leadWithToolResults(next, stubs);
    else if (stubs.length > 0) out.push({ role: 'user', content: stubs });
  }
  return out;
}

/**
 * Fold a plain user text turn into the trailing tool_result block of the
 * previous user message (first-party client parity: merge user content
 * blocks into the trailing tool_result). Any sibling text after a
 * tool_result renders as `</function_results>\n\nHuman:<...>` on the
 * Anthropic wire; repeated mid-conversation this teaches the model to emit
 * 3-token empty end_turn completions (upstream A/B sai-20260310-161901:
 * 92% → 0% after smooshing). Observed in mixdog as the empty-turn nudge
 * livelock: each contract nudge was pushed as its own user turn right after
 * a tool_result turn, reinforcing the empty-completion pattern.
 *
 * Returns true when the text was folded (caller must NOT push the message);
 * false when the message must keep its own turn (no tool_result tail,
 * tool_reference result, or non-text content such as images).
 */
export function foldUserTextIntoToolResultTail(result, content) {
  const last = result[result.length - 1];
  if (last?.role !== 'user' || !Array.isArray(last.content) || last.content.length === 0) return false;
  const tail = last.content[last.content.length - 1];
  if (tail?.type !== 'tool_result') return false;
  // tool_reference results must keep their exact shape — leave as sibling.
  if (Array.isArray(tail.content) && tail.content.some((b) => b?.type === 'tool_reference')) return false;
  // Only fold pure text (string or all-text blocks). Images/documents keep
  // their own user turn.
  let texts;
  if (typeof content === 'string') {
    texts = content.trim() ? [content.trim()] : [];
  } else if (Array.isArray(content) && content.every((b) => b?.type === 'text' && typeof b.text === 'string')) {
    texts = content.map((b) => b.text.trim()).filter(Boolean);
  } else {
    return false;
  }
  if (texts.length === 0) return true; // empty text turn — drop it entirely
  const joined = texts.join('\n\n');
  if (typeof tail.content === 'string') {
    last.content[last.content.length - 1] = {
      ...tail,
      content: tail.content.trim() ? `${tail.content}\n\n${joined}` : joined,
    };
    return true;
  }
  if (Array.isArray(tail.content)) {
    const blocks = tail.content.slice();
    const prev = blocks[blocks.length - 1];
    if (prev?.type === 'text' && typeof prev.text === 'string') {
      blocks[blocks.length - 1] = { ...prev, text: `${prev.text}\n\n${joined}` };
    } else {
      blocks.push({ type: 'text', text: joined });
    }
    last.content[last.content.length - 1] = { ...tail, content: blocks };
    return true;
  }
  return false;
}
