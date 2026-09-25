// Responses-API stream event handlers for the OpenAI-compat consumer. Each
// wire event type maps to one handler over the shared stream `state`; `ctx`
// carries the label, the caller callbacks and the leaked-text relay.
import { typedStatusFrom } from './retry-classifier.mjs';
import { customToolCallFromResponseItem, nativeToolSearchCallFromArguments } from './custom-tool-wire.mjs';
import { emitCompatToolCallOnce } from './openai-compat-stream-common.mjs';
import { truncatedCompatStreamError, parseCompletedToolCallArgumentsJson } from './lib/openai-tool-args.mjs';
import { incompleteReasonFromEvent, isMaxOutputIncompleteReason } from './lib/responses-terminal-fields.mjs';

function signal(ctx, kind) {
  try {
    ctx.onStreamDelta?.(kind);
  } catch {}
}

// Copy the TYPED failure evidence a Responses `response.failed` / `error`
// event carries (numeric HTTP status, provider error code/type) onto the
// thrown error. Message text is never parsed, and nothing is synthesized when
// the event declares no typed status. The wire-event marker routes the error
// through the fatal-code deny-list / default-retry classification.
function typedResponsesFailure(message, event) {
  const err = new Error(message);
  const detail = event?.response?.error || event?.error || null;
  const typed = typedStatusFrom(detail, event);
  if (typed) err.httpStatus = typed;
  const code = detail?.code ?? detail?.type ?? event?.code ?? null;
  if (code != null && code !== '') err.providerErrorCode = String(code);
  if (detail) err.providerError = detail;
  err.providerWireError = true;
  return err;
}

// Reconcile a COMPLETED function_call item into state.toolCalls: fill in the
// id/name a streamed call may still be missing, or adopt the item as a new
// call. `response.output_item.done` and the `response.completed` sweep see the
// same item shape and must land on the same single emit, so both route here.
// Returns the item id the done-branch still needs for its pendingCalls /
// tool-tracker bookkeeping.
function reconcileCompatFunctionCallItem(state, item, label, onToolCall) {
  const itemId = item.id || '';
  const tc =
    state.toolCalls.find((t) => t._pendingItemId === itemId) ||
    (item.call_id ? state.toolCalls.find((t) => t.id === item.call_id) : null);
  if (tc) {
    if (!tc.id && item.call_id) tc.id = item.call_id;
    if (!tc.name && item.name) tc.name = item.name;
    if (tc.id && tc.name) delete tc._pendingItemId;
    emitCompatToolCallOnce(state, tc, onToolCall);
  } else if (item.call_id && item.name) {
    const call = {
      id: item.call_id,
      name: item.name,
      arguments: parseCompletedToolCallArgumentsJson(item.arguments, label, {
        id: item.call_id,
        name: item.name,
        finishReason: 'done',
      }),
    };
    state.toolCalls.push(call);
    emitCompatToolCallOnce(state, call, onToolCall);
  }
  return itemId;
}

function pushToolSearchCall(state, item, ctx) {
  if (item?.type !== 'tool_search_call') return;
  const callId = item.call_id || item.id || '';
  if (!callId || state.toolCalls.some((call) => call.id === callId)) return;
  const _tsArgs =
    item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
      ? item.arguments
      : parseCompletedToolCallArgumentsJson(item.arguments || '{}', ctx.label, {
          id: callId,
          name: 'tool_search',
          finishReason: 'done',
        });
  const call = nativeToolSearchCallFromArguments(
    callId,
    // Schema is a plain object ({query,select,limit}); an array must
    // never pass through as args.
    _tsArgs && typeof _tsArgs === 'object' && !Array.isArray(_tsArgs) ? _tsArgs : {}
  );
  state.toolCalls.push(call);
  emitCompatToolCallOnce(state, call, ctx.onToolCall);
}

function pushCustomToolCall(state, item, ctx) {
  const call = customToolCallFromResponseItem(item);
  if (!call || state.toolCalls.some((existing) => existing.id === call.id)) return;
  state.toolCalls.push(call);
  emitCompatToolCallOnce(state, call, ctx.onToolCall);
}

function recomputeToolInFlight(state) {
  state.toolInFlight = state.pendingCalls.size > 0 || (state.toolTracker ? state.toolTracker.items.size > 0 : false);
}

// Max-output cutoff with a tool call still in flight means the function-call
// arguments were truncated — do NOT mark this a clean completion, or partial
// args surface as a successful tool call. Treat as unsafe/partial instead.
function settleMaxOutputIncomplete(event, state, ctx, reason) {
  if (state.toolInFlight || (state.pendingCalls && state.pendingCalls.size > 0)) {
    const err = truncatedCompatStreamError(ctx.label, `incomplete (${reason}) with tool call in flight`);
    err.streamStalled = true;
    err.pendingToolUse = true;
    err.partialContent = state.content || '';
    throw err;
  }
  state.completed = true;
  state.stopReason = 'length';
  state.completedResponse = event.response || state.completedResponse;
}

function onCreated(event, state, ctx) {
  if (event.response?.model) state.model = event.response.model;
  if (event.response?.id) state.responseId = event.response.id;
  signal(ctx, 'semantic');
}

function onOutputTextDelta(event, state, ctx) {
  state.sawOutput = true;
  // Route assistant text through the leaked-tool-call guard (appends
  // to state.content, forwards visible text, recovers leaked calls).
  if (ctx.relayLeakText) {
    ctx.relayLeakText(event.delta || '');
    return;
  }
  state.content += event.delta || '';
  if (event.delta) signal(ctx, 'text');
  if (event.delta && ctx.onTextDelta) {
    state.emittedText = true;
    try {
      ctx.onTextDelta(event.delta);
    } catch {}
  }
}

function onReasoningDelta(event, state, ctx) {
  if (!event.delta) return;
  // Reasoning exposure latch (mirrors the Chat path): set at
  // DELTA time, not at completion. Exposed reasoning cannot be
  // withdrawn, so any later failure is non-replayable — a retry
  // or non-streaming reset would duplicate it.
  state.emittedReasoning = true;
  signal(ctx, 'reasoning');
}

function onOutputItemAdded(event, state, ctx) {
  const type = event.item?.type;
  if (type === 'function_call') {
    state.pendingCalls.set(event.item.id || '', {
      name: event.item.name || '',
      callId: event.item.call_id || '',
    });
    state.toolTracker?.mark(event.item);
    state.toolInFlight = true;
  } else if (type === 'custom_tool_call' || type === 'tool_search_call') {
    // tool_search is marked in-flight at item-added time, same as
    // function_call/custom_tool_call, so the stall-recovery pendingToolUse
    // gate never drops a mid-flight tool_search before output_item.done
    // pushes it.
    state.toolTracker?.mark(event.item);
    state.toolInFlight = true;
  }
  signal(ctx, state.toolInFlight ? 'tool' : 'semantic');
}

// A tool call's args (or custom-tool input) are streaming — mark tool work
// in-flight so a mid-args stall is NEVER accepted as a text-only partial-final
// (otherwise a tool-bearing turn looks text-only).
function onToolInputDelta(event, state, ctx) {
  state.toolTracker?.mark(null, event.item_id);
  state.toolInFlight = true;
  signal(ctx, 'tool');
}

function onFunctionCallArgumentsDone(event, state, ctx) {
  const itemId = event.item_id || '';
  const pending = state.pendingCalls.get(itemId);
  const call = {
    id: pending?.callId || event.call_id || '',
    name: pending?.name || event.name || '',
    // `*.done` ⇒ arguments are complete; a parse failure is
    // deterministic bad JSON (permanent), not stream truncation.
    arguments: parseCompletedToolCallArgumentsJson(event.arguments, ctx.label, {
      id: pending?.callId || event.call_id,
      name: pending?.name || event.name,
      finishReason: 'done',
    }),
    _pendingItemId: itemId,
  };
  state.toolCalls.push(call);
  if (call.id && call.name) delete call._pendingItemId;
  emitCompatToolCallOnce(state, call, ctx.onToolCall);
  signal(ctx, 'tool');
}

function onOutputItemDone(event, state, ctx) {
  const item = event.item || {};
  if (item.type === 'function_call') {
    const itemId = reconcileCompatFunctionCallItem(state, item, ctx.label, ctx.onToolCall);
    // Drop the resolved function item from pendingCalls before
    // recomputing toolInFlight — otherwise a completed call keeps
    // pendingCalls.size > 0 and the latch never clears, so a later
    // text-only stall stays wrongly gated as tool-bearing.
    if (itemId) state.pendingCalls.delete(itemId);
    state.toolTracker?.clear(item, itemId);
    recomputeToolInFlight(state);
  } else if (item.type === 'tool_search_call') {
    pushToolSearchCall(state, item, ctx);
    state.toolTracker?.clear(item, item.id || '');
    recomputeToolInFlight(state);
  } else if (item.type === 'custom_tool_call') {
    pushCustomToolCall(state, item, ctx);
    state.toolTracker?.clear(item, item.id || '');
    recomputeToolInFlight(state);
  }
  let kind = 'semantic';
  if (item.type === 'reasoning') kind = 'reasoning';
  else if (/tool|function_call|web_search_call/.test(item.type || '')) kind = 'tool';
  signal(ctx, kind);
}

// Text the stream never delivered as deltas: adopt the completed response's
// output_text (through the leak guard when one is active).
function adoptFallbackText(state, ctx, resp) {
  const fallbackText = ctx.responseOutputText(resp);
  if (!fallbackText) return false;
  if (ctx.relayLeakText) {
    const result = ctx.relayLeakText(fallbackText, true);
    return !!(result?.text || result?.tool);
  }
  state.content = fallbackText;
  signal(ctx, 'text');
  return true;
}

// One completed output item; true when it counted as bundle progress.
function sweepCompletedItem(state, ctx, item) {
  switch (item?.type) {
    case 'function_call':
      reconcileCompatFunctionCallItem(state, item, ctx.label, ctx.onToolCall);
      signal(ctx, 'tool');
      return true;
    case 'tool_search_call':
      pushToolSearchCall(state, item, ctx);
      signal(ctx, 'tool');
      return true;
    case 'custom_tool_call':
      pushCustomToolCall(state, item, ctx);
      signal(ctx, 'tool');
      return true;
    case 'reasoning':
      signal(ctx, 'reasoning');
      return true;
    case 'web_search_call':
      signal(ctx, 'tool');
      return true;
    default:
      return false;
  }
}

function onCompleted(event, state, ctx) {
  const resp = event.response || {};
  state.completed = true;
  state.completedResponse = resp;
  if (!state.model && resp.model) state.model = resp.model;
  if (!state.responseId && resp.id) state.responseId = resp.id;
  let reportedBundleProgress = !state.content && adoptFallbackText(state, ctx, resp);
  for (const item of resp.output || []) {
    reportedBundleProgress = sweepCompletedItem(state, ctx, item) || reportedBundleProgress;
  }
  if (!reportedBundleProgress) signal(ctx, 'semantic');
}

function onDone(event, state, ctx) {
  if (!event.response || event.response.status === 'completed') {
    state.completed = true;
    return;
  }
  if (event.response.status === 'failed') {
    const msg = event.response?.error?.message || 'response.done failed';
    throw typedResponsesFailure(`xAI Responses stream response.done failed: ${msg}`, event);
  }
  if (event.response.status === 'incomplete') {
    const reason = incompleteReasonFromEvent(event);
    if (isMaxOutputIncompleteReason(reason)) return settleMaxOutputIncomplete(event, state, ctx, reason);
    throw new Error(`xAI Responses stream response.done incomplete: ${reason}`);
  }
}

function onFailed(event) {
  const msg = event.response?.error?.message || event.error?.message || event.message || 'response.failed';
  // The wire event's OWN typed status/code is preserved verbatim. A
  // forbidden/unknown failure is never coerced into a synthetic 500:
  // without typed evidence it stays unclassified and is surfaced.
  throw typedResponsesFailure(`xAI Responses stream response.failed: ${msg}`, event);
}

function onIncomplete(event, state, ctx) {
  const reason = incompleteReasonFromEvent(event);
  if (isMaxOutputIncompleteReason(reason)) return settleMaxOutputIncomplete(event, state, ctx, reason);
  throw new Error(`xAI Responses stream response.incomplete: ${reason}`);
}

function onError(event) {
  const msg = event.message || event.error?.message || 'unknown';
  throw typedResponsesFailure(`xAI Responses stream error: ${msg}`, event);
}

const RESPONSES_EVENT_HANDLERS = new Map([
  ['response.created', onCreated],
  ['response.output_text.delta', onOutputTextDelta],
  ['response.reasoning_text.delta', onReasoningDelta],
  ['response.reasoning_summary_text.delta', onReasoningDelta],
  ['response.output_item.added', onOutputItemAdded],
  ['response.function_call_arguments.delta', onToolInputDelta],
  ['response.custom_tool_call_input.delta', onToolInputDelta],
  ['response.function_call_arguments.done', onFunctionCallArgumentsDone],
  ['response.output_item.done', onOutputItemDone],
  ['response.completed', onCompleted],
  ['response.done', onDone],
  ['response.failed', onFailed],
  ['response.incomplete', onIncomplete],
  ['error', onError],
]);

export function handleCompatResponsesStreamEvent(event, state, ctx) {
  if (!event || typeof event.type !== 'string') return;
  const handler = RESPONSES_EVENT_HANDLERS.get(event.type);
  if (handler) handler(event, state, ctx);
}
