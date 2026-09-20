/**
 * openai-http-sse-response-state/response-items.mjs — how Responses output
 * items fold into the record: the single-emit tool-call dispatch, replay
 * items, reasoning items, web_search / tool_search / custom tool calls and
 * pending function_call completion.
 */
import { makeInvalidToolArgsMarker } from '../openai-compat-stream.mjs';
import { customToolCallFromResponseItem, nativeToolSearchCallFromArguments } from '../custom-tool-wire.mjs';

// Completed function_call.arguments parse for the OpenAI Responses stream.
// A function_call item arrives only on a completion/done signal, so a
// non-empty-but-malformed
// arguments string is deterministic bad JSON — NOT mid-stream truncation.
// Empty/whitespace input legitimately means "no arguments" → {}. A non-empty
// string that fails JSON.parse is surfaced as an invalid-args MARKER (instead
// of being silently swallowed to {}) so the dispatch loop turns it into an
// is_error tool_result and the model self-corrects in the same turn.
export function parseJsonObject(value) {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (value != null) text = String(value);
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return makeInvalidToolArgsMarker(text, err instanceof Error ? err.message : String(err));
  }
}

export function createResponseItems({ state, onToolCall }) {
  // Route every emit through emitToolCall: it fires the callback exactly
  // once per unique call id, the first time the call is complete. A call
  // whose id/name only arrives in a later frame is NOT dropped — its first
  // complete frame still emits; only redundant re-emits are suppressed.
  const emitToolCall = (call) => {
    if (!call?.id) return;
    if (state.emittedToolCallIds.has(call.id)) return;
    state.emittedToolCallIds.add(call.id);
    if (!state.toolDedupe.shouldDispatch(call.name, call.arguments, call.id)) return;
    state.emittedToolCall = true;
    try {
      onToolCall?.(call);
    } catch {}
  };

  const pushWebSearchCall = (item) => {
    if (item?.type !== 'web_search_call') return;
    const key = item.id || JSON.stringify(item.action || item);
    if (state.webSearchCallKeys.has(key)) return;
    state.webSearchCallKeys.add(key);
    state.webSearchCalls.push({ id: item.id || '', status: item.status || '', action: item.action || null });
  };
  const pushReasoningItem = (item) => {
    if (item?.type === 'reasoning' && item.encrypted_content && !state.reasoningItems.some((r) => r.id === item.id)) {
      state.reasoningItems.push({
        id: item.id || '',
        encrypted_content: item.encrypted_content,
        summary: Array.isArray(item.summary) ? item.summary : [],
      });
    }
  };
  const pushResponseItem = (item) => {
    if (!item || typeof item !== 'object') return;
    let fallbackKey = '';
    try {
      fallbackKey = JSON.stringify(item);
    } catch {}
    const key = `${item.type || 'unknown'}:${item.id || item.call_id || fallbackKey}`;
    if (state.responseItemKeys.has(key)) return;
    state.responseItemKeys.add(key);
    try {
      state.responseItems.push(structuredClone(item));
    } catch {
      state.responseItems.push({ ...item });
    }
  };
  const pushToolSearchCall = (item) => {
    if (item?.type !== 'tool_search_call') return;
    const callId = item.call_id || item.id || '';
    if (!callId || state.toolCalls.some((t) => t.id === callId)) return;
    let args = {};
    if (item.arguments && typeof item.arguments === 'object') {
      args = item.arguments;
    } else if (typeof item.arguments === 'string' && item.arguments.trim()) {
      // Non-empty but malformed tool_search arguments are deterministic
      // bad JSON (the item is only emitted on completion). Surface an
      // invalid-args marker instead of swallowing to {} so the model can
      // self-correct in the same turn.
      args = parseJsonObject(item.arguments);
    }
    const call = nativeToolSearchCallFromArguments(callId, args);
    state.toolCalls.push(call);
    emitToolCall(call);
  };
  const pushCustomToolCall = (item) => {
    const call = customToolCallFromResponseItem(item);
    if (!call || state.toolCalls.some((t) => t.id === call.id)) return;
    state.toolCalls.push(call);
    emitToolCall(call);
  };
  // A pending function_call placeholder completes (id + name) either at
  // arguments.done or at a later item frame; emit the first time it does.
  const completePendingCall = (tc, item) => {
    if (!tc.id && item.call_id) tc.id = item.call_id;
    if (!tc.name && item.name) tc.name = item.name;
    if (tc.id && tc.name) {
      delete tc._pendingItemId;
      emitToolCall(tc);
    }
  };
  const absorbCompletedFunctionCall = (item) => {
    // Match the still-pending placeholder by item id, or an already-recorded
    // call by its canonical call_id — so a call completed at args.done /
    // output_item.done is reused here rather than re-pushed as a duplicate.
    const tc = state.toolCalls.find(
      (t) => t._pendingItemId === (item.id || '') || (item.call_id && t.id === item.call_id)
    );
    if (tc) {
      completePendingCall(tc, item);
    } else if (item.call_id && item.name) {
      const call = {
        id: item.call_id,
        name: item.name,
        arguments: parseJsonObject(item.arguments),
      };
      state.toolCalls.push(call);
      emitToolCall(call);
    }
  };

  return {
    emitToolCall,
    pushWebSearchCall,
    pushReasoningItem,
    pushResponseItem,
    pushToolSearchCall,
    pushCustomToolCall,
    completePendingCall,
    absorbCompletedFunctionCall,
  };
}
