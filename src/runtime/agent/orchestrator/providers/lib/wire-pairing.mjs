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

// Result ids of the contiguous tool-message run that immediately follows the
// assistant message at `index`. Only that run answers its tool_calls block.
function followingChatResultIds(messages, index) {
  const ids = new Set();
  for (let j = index + 1; j < messages.length; j += 1) {
    const message = messages[j];
    if (!isObject(message) || message.role !== 'tool') break;
    const id = chatResultId(message);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Ensure every chat assistant `tool_calls` entry is answered by a tool
 * message in the run immediately following that assistant message (OpenAI
 * function calling / Meta chat contract). A result after an intervening
 * user/assistant message, or one answering another occurrence of the same id,
 * does not pair it. Returns the original array when already paired, otherwise
 * a new array with synthetic tool messages inserted right after the assistant
 * message.
 */
export function ensureChatToolPairs(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  let out = null;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const callIds = chatToolCallIds(message);
    const answered = callIds.length ? followingChatResultIds(messages, i) : null;
    const missing = callIds.filter((id) => !answered.has(id));
    if (missing.length && !out) out = messages.slice(0, i);
    if (!out) continue;
    out.push(message);
    for (const id of missing) out.push({ role: 'tool', tool_call_id: id, content: WIRE_PAIRING_STUB });
  }
  return out || messages;
}
