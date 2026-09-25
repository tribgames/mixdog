import { makeInvalidToolArgsMarker } from '../openai-compat-stream.mjs';
import { synthLeakedOpenAICall } from '../openai-compat-stream-common.mjs';
import { createToolCallDedupe, dedupeToolCallList } from '../anthropic-leaked-toolcall.mjs';
import { customToolCallFromResponseItem, nativeToolSearchCallFromArguments } from '../custom-tool-wire.mjs';
import { createActiveToolItemTracker } from '../tool-stream-state.mjs';

// tool_search_call.arguments parse. Module-scope (exported) for direct test
// coverage. Same policy as the function_call_arguments.done path and
// openai-oauth _parseJsonObject — object passes through; null/non-string/
// empty/whitespace → {} (no args); a non-empty string that fails JSON.parse is
// deterministic bad JSON, surfaced as an invalid-args MARKER (not silently
// swallowed to {}) so the dispatch loop returns an is_error tool_result and
// the model self-corrects in the same turn.
export function parseToolSearchArgs(value) {
  if (value && typeof value === 'object') {
    // Reject arrays — the tool_search schema is an object
    // ({query,select,limit}); an array must never pass through as args.
    return Array.isArray(value) ? {} : value;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return makeInvalidToolArgsMarker(value, err instanceof Error ? err.message : String(err));
  }
}

// function_call arguments are a completion signal: empty/whitespace → no args
// ({}); a non-empty string that fails JSON.parse is deterministic bad JSON.
// Surface an invalid-args MARKER (not silent {}) so the dispatch loop returns
// an is_error tool_result and the model re-issues valid JSON in the same turn.
function parseFunctionCallArgs(argsText) {
  if (argsText.trim() === '') return {};
  try {
    return JSON.parse(argsText);
  } catch (err) {
    return makeInvalidToolArgsMarker(argsText, err instanceof Error ? err.message : String(err));
  }
}

const argsTextOf = (value) => (typeof value === 'string' ? value : '');

// Tool calls of one WS response: native function calls (pending until their
// arguments complete), custom and tool_search calls, text-leaked recoveries,
// the tool-in-flight flag the stall gates read, and the cross-path
// name+args dedupe so a leaked synthetic and an identical native call fire
// onToolCall exactly once.
export function createWsToolCalls({ onToolCall, midState, replayItems }) {
  const toolCalls = [];
  const pendingCalls = new Map();
  const toolTracker = createActiveToolItemTracker();
  const activeToolItems = toolTracker.items;
  // Set the moment a function/custom tool call's input starts streaming
  // (before it lands in pendingCalls/toolCalls). Gates partial-final SUCCESS
  // so a stall mid tool-input never looks text-only.
  let toolInFlight = false;
  const toolDedupe = createToolCallDedupe();

  function fire(call) {
    midState.emittedToolCall = true;
    try {
      onToolCall?.(call);
    } catch {}
  }
  function emit(call) {
    if (!toolDedupe.shouldDispatch(call?.name, call?.arguments, call?.id)) return;
    fire(call);
  }
  function settle() {
    toolInFlight = pendingCalls.size > 0 || activeToolItems.size > 0;
  }
  function markStarted(item) {
    midState.startedToolCall = true;
    toolTracker.mark(item);
    toolInFlight = true;
  }

  function pushCustomToolCall(item) {
    const call = customToolCallFromResponseItem(item);
    if (!call || toolCalls.some((existing) => existing.id === call.id)) return;
    toolCalls.push(call);
    emit(call);
  }
  function pushToolSearchCall(item) {
    if (item?.type !== 'tool_search_call') return;
    const callId = item.call_id || item.id || '';
    if (!callId || toolCalls.some((call) => call.id === callId)) return;
    const call = nativeToolSearchCallFromArguments(callId, parseToolSearchArgs(item.arguments));
    toolCalls.push(call);
    emit(call);
  }

  /** A tool call recovered from leaked text. True when it was dispatched
   *  (not a duplicate of a native call). */
  function dispatchLeakedCall(recovered) {
    const call = synthLeakedOpenAICall(recovered);
    if (!toolDedupe.shouldDispatch(call.name, call.arguments, call.id)) return false;
    toolCalls.push(call);
    fire(call);
    return true;
  }

  /** response.output_item.added */
  function noteItemAdded(item) {
    const type = item?.type;
    if (type === 'function_call') {
      markStarted(item);
      pendingCalls.set(item.id || '', { name: item.name || '', callId: item.call_id || '' });
    } else if (type === 'custom_tool_call' || type === 'tool_search_call') {
      // tool_search is marked in-flight at item-added time too, so the
      // semantic-idle stall gate's pendingToolUse never drops a mid-flight
      // tool_search before response.output_item.done.
      markStarted(item);
    }
  }

  /** response.function_call_arguments.delta / custom_tool_call_input.delta */
  function noteToolInputDelta(itemId, delta) {
    if (delta) midState.startedToolCall = true;
    toolTracker.mark(null, itemId);
    toolInFlight = true;
  }

  /** response.function_call_arguments.done */
  function completeFunctionCallArguments(event) {
    const itemId = event.item_id || '';
    const pending = pendingCalls.get(itemId);
    const args = parseFunctionCallArgs(argsTextOf(event.arguments));
    replayItems.enrichFunctionCall({
      itemId,
      callId: pending?.callId || event.call_id || '',
      name: pending?.name || event.name || '',
      argumentsText: event.arguments || JSON.stringify(args),
    });
    if (pending?.callId && pending?.name) {
      const call = { id: pending.callId, name: pending.name, arguments: args };
      toolCalls.push(call);
      emit(call);
      pendingCalls.delete(itemId);
      // Keep the function item active until output_item.done: arguments.done
      // completes args, but the lifecycle item itself may still be followed
      // by item.done/final frames.
      settle();
      return;
    }
    // Synthesizing a `tc_${Date.now()}` callId here would make the next turn
    // fail to match the model's function_call_output reference. Defer instead
    // and salvage call_id/name from the final response.completed.output
    // bundle. If salvage also fails the stream fails explicitly — masking the
    // gap with a synthetic id just shifts the failure one turn later under a
    // confusing "No tool output found for function call" error.
    toolCalls.push({
      id: pending?.callId || '',
      name: pending?.name || '',
      arguments: args,
      _pendingItemId: itemId,
      _deferred: true,
    });
  }

  /** response.output_item.done for a function_call item */
  function completeFunctionCallItem(item) {
    const itemId = item.id || '';
    const callId = item.call_id || '';
    const name = item.name || '';
    const args = parseFunctionCallArgs(argsTextOf(item.arguments));
    const deferred = toolCalls.find((tc) => tc?._deferred && (!itemId || tc._pendingItemId === itemId));
    if (deferred && callId && name) {
      deferred.id = callId;
      deferred.name = name;
      deferred.arguments = deferred.arguments && Object.keys(deferred.arguments).length > 0 ? deferred.arguments : args;
      delete deferred._deferred;
      delete deferred._pendingItemId;
      emit(deferred);
    } else if (callId && name && !toolCalls.some((tc) => tc?.id === callId)) {
      const call = { id: callId, name, arguments: args };
      toolCalls.push(call);
      emit(call);
    }
    if (itemId) pendingCalls.delete(itemId);
    toolTracker.clear(item, itemId);
    settle();
  }
  function completeToolSearchItem(item) {
    pushToolSearchCall(item);
    toolTracker.clear(item);
    settle();
  }
  function completeCustomToolItem(item) {
    pushCustomToolCall(item);
    toolTracker.clear(item);
    settle();
  }

  /** response.completed salvage: when arguments.done fired before (or
   *  without) a matching output_item.added, the deferred placeholder has an
   *  empty id/name; the bundle carries the canonical call_id/name. */
  function salvageFunctionCall(item) {
    const tc = toolCalls.find((t) => t._deferred && t._pendingItemId === (item.id || ''));
    if (!tc) return;
    if (!tc.id && item.call_id) tc.id = item.call_id;
    if (!tc.name && item.name) tc.name = item.name;
    if (tc.id && tc.name) {
      delete tc._deferred;
      delete tc._pendingItemId;
      emit(tc);
    }
  }

  return {
    get calls() {
      return toolCalls;
    },
    get inFlight() {
      return toolInFlight;
    },
    /** A tool input never finished streaming — a fully assembled call is not pending. */
    get pendingToolUse() {
      return pendingCalls.size > 0 || activeToolItems.size > 0 || toolInFlight === true;
    },
    get pendingToolInput() {
      return pendingCalls.size > 0 || toolInFlight === true;
    },
    get started() {
      return midState.startedToolCall === true || pendingCalls.size > 0;
    },
    // Dedupe by name+args so an identical synthetic-leaked + native pair
    // can't run the tool twice.
    dedupedList: () => dedupeToolCallList(toolCalls),
    unresolvedDeferredCall: () => toolCalls.find((t) => t._deferred),
    pushCustomToolCall,
    pushToolSearchCall,
    dispatchLeakedCall,
    noteItemAdded,
    noteToolInputDelta,
    completeFunctionCallArguments,
    completeFunctionCallItem,
    completeToolSearchItem,
    completeCustomToolItem,
    salvageFunctionCall,
  };
}
