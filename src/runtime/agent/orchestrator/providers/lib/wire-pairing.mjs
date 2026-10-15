/**
 * Wire-level tool-call pairing guards for non-Anthropic request builders.
 *
 * Session history can hold an assistant tool call with no matching result
 * (user cancel or stream abort between call dispatch and result commit).
 * Loop-level repair works on the internal message shape and cannot see
 * inside provider replay envelopes, so a wire builder that replays such a
 * call verbatim produces a request the provider hard-rejects
 * (Responses `invalid_request_error`, chat `tool_calls` without tool
 * messages). The failure is deterministic: every retry resends the same
 * unpaired call.
 *
 * These post-passes run on the FINAL wire arrays, after replay expansion,
 * and insert a synthetic result immediately after each unpaired call so the
 * request is always well-formed. Orphan results (a result with no visible
 * call) are left alone: incremental continuations legitimately carry only
 * the new results while the call lives server-side.
 */

// Synthetic result body for calls that never completed. Matches the
// cancellation vocabulary used for interrupted tool results elsewhere.
export const WIRE_PAIRING_STUB = 'Cancelled';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A server-executed tool search (execution:'server', or call_id null) is
// answered by the server inside the same response. It is never a client call
// awaiting a client output, so the guard neither pairs nor synthesizes it.
function isServerToolSearch(item) {
  return (item.type === 'tool_search_call' || item.type === 'tool_search_output') &&
    (item.execution === 'server' || item.call_id === null);
}

function responsesCallId(item) {
  if (!isObject(item)) return null;
  if (item.type !== 'function_call' && item.type !== 'custom_tool_call' && item.type !== 'tool_search_call')
    return null;
  if (isServerToolSearch(item)) return null;
  const id = item.call_id || item.id || '';
  return typeof id === 'string' && id ? id : null;
}

function responsesOutputId(item) {
  if (!isObject(item)) return null;
  if (
    item.type !== 'function_call_output' &&
    item.type !== 'custom_tool_call_output' &&
    item.type !== 'tool_search_output'
  )
    return null;
  if (isServerToolSearch(item)) return null;
  const id = item.call_id || item.id || '';
  return typeof id === 'string' && id ? id : null;
}

function syntheticResponsesOutput(call) {
  if (call.type === 'custom_tool_call') {
    return {
      type: 'custom_tool_call_output',
      call_id: call.call_id || call.id || '',
      output: WIRE_PAIRING_STUB,
    };
  }
  if (call.type === 'tool_search_call') {
    return {
      type: 'tool_search_output',
      call_id: call.call_id || call.id || '',
      status: 'completed',
      execution: 'client',
      tools: [],
    };
  }
  return {
    type: 'function_call_output',
    call_id: call.call_id || call.id || '',
    output: WIRE_PAIRING_STUB,
  };
}

/**
 * Ensure every Responses call item in a finished input array has a matching
 * output item. Returns the original array when already paired, otherwise a
 * new array with synthetic outputs inserted right after their calls.
 */
export function ensureResponsesCallOutputs(items) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const outputIds = new Set();
  for (const item of items) {
    const id = responsesOutputId(item);
    if (id) outputIds.add(id);
  }
  let missing = 0;
  for (const item of items) {
    const id = responsesCallId(item);
    if (id && !outputIds.has(id)) missing += 1;
  }
  if (missing === 0) return items;
  const out = [];
  for (const item of items) {
    out.push(item);
    const id = responsesCallId(item);
    if (id && !outputIds.has(id)) {
      out.push(syntheticResponsesOutput(item));
      outputIds.add(id);
    }
  }
  return out;
}

function chatToolCallIds(message) {
  if (!isObject(message) || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return [];
  const ids = [];
  for (const call of message.tool_calls) {
    const id = call?.id;
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function chatResultId(message) {
  if (!isObject(message) || message.role !== 'tool') return null;
  const id = message.tool_call_id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Ensure every chat assistant `tool_calls` entry is answered by a tool
 * message in the run immediately following that assistant message (OpenAI
 * function calling / Meta chat contract), and that no tool message exists
 * anywhere else. A result after an intervening user/assistant message, or one
 * answering another occurrence of the same id, does not pair the call; the
 * call gets a synthetic stub right after its assistant message and the
 * misplaced tool message is DROPPED (Chat Completions rejects a tool message
 * that does not follow its tool_calls block; a late result is not relocated).
 * Within the run, results for ids the block did not call and repeated results
 * for one id are dropped too. Returns the original array when already valid.
 */
export function ensureChatToolPairs(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const out = [];
  let changed = false;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (isObject(message) && message.role === 'tool') {
      changed = true;
      continue;
    }
    out.push(message);
    const callIds = chatToolCallIds(message);
    if (!callIds.length) continue;
    let end = i + 1;
    while (end < messages.length && isObject(messages[end]) && messages[end].role === 'tool') end += 1;
    const answered = new Set();
    const kept = [];
    for (const result of messages.slice(i + 1, end)) {
      const id = chatResultId(result);
      if (id && callIds.includes(id) && !answered.has(id)) {
        answered.add(id);
        kept.push(result);
      } else {
        changed = true;
      }
    }
    for (const id of callIds) {
      if (answered.has(id)) continue;
      changed = true;
      out.push({ role: 'tool', tool_call_id: id, content: WIRE_PAIRING_STUB });
    }
    out.push(...kept);
    i = end - 1;
  }
  return changed ? out : messages;
}
