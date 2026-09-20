// Per-stream state of the OpenAI-compat Responses consumer, the leaked
// tool-call relay over its text, the canonical stream-outcome stamp and the
// final result assembly.
import { stampStreamOutcome, STREAM_TRANSPORTS } from './lib/stream-outcome.mjs';
import { createLeakGuard, createToolCallDedupe, dedupeToolCallList } from './anthropic-leaked-toolcall.mjs';
import { createActiveToolItemTracker } from './tool-stream-state.mjs';
import { emitCompatToolCallOnce, synthLeakedOpenAICall } from './openai-compat-stream-common.mjs';

export function createResponsesStreamState() {
  return {
    content: '',
    model: '',
    responseId: '',
    stopReason: null,
    toolCalls: [],
    pendingCalls: new Map(),
    emittedToolCallKeys: new Set(),
    emittedToolCall: false,
    // Active tool-item / alias tracking shared with the WS + HTTP-SSE
    // Responses streams (tool-stream-state.mjs): mark on output_item.added /
    // arg-input deltas, clear on output_item.done. Unions id/call_id/item_id
    // aliases so a mark under one key and a clear under another resolve to
    // the same item — closes the custom-tool-input in-flight gap that a bare
    // boolean toolInFlight latch could not (a mid-input stall now gates out
    // text-only partial-final).
    toolTracker: createActiveToolItemTracker(),
    completed: false,
    completedResponse: null,
    sawOutput: false,
    // Fix 2: cross-path name+args dedupe shared by synthetic leaked-call
    // dispatch and every native emit in this Responses stream.
    _toolDedupe: createToolCallDedupe(),
    // Gateway live-text relay invariant: set once a non-empty text chunk
    // has been forwarded. A later failure is non-retryable (rendered text
    // cannot be withdrawn; a retry would concatenate attempts).
    emittedText: false,
    // Reasoning-exposure invariant, latched by
    // handleCompatResponsesStreamEvent on the first non-empty reasoning
    // delta (see the Chat path's emittedReasoning).
    emittedReasoning: false,
    semanticIdleDeadlineAt: 0,
  };
}

// Leaked tool-call guard for the Responses text stream. Same recovery as
// the Chat path: leaked XML/harmony tool syntax in `output_text.delta` is
// suppressed from visible text, synthesized, and dispatched like native.
export function createResponsesLeakRelay({ state, knownToolNames, onToolCall, onTextDelta, reportProgress }) {
  const leakGuard = createLeakGuard({ knownToolNames, harmony: true });
  const leakedCalls = [];
  const dispatchLeakedCall = (recovered) => {
    const call = synthLeakedOpenAICall(recovered);
    emitCompatToolCallOnce(state, call, onToolCall);
    leakedCalls.push(call);
    reportProgress('tool');
  };
  const forwardText = (text) => {
    if (!text) return;
    state.content += text;
    reportProgress('text');
    if (onTextDelta) {
      state.emittedText = true;
      try {
        onTextDelta(text);
      } catch {}
    }
  };
  const relayLeakText = leakGuard.enabled
    ? (delta, final = false) => {
        const { text, calls } = leakGuard.push(delta, final);
        forwardText(text);
        for (const c of calls) dispatchLeakedCall(c);
        return { text: !!text, tool: calls.length > 0 };
      }
    : null;
  const flushLeak = () => {
    if (!leakGuard.enabled) return;
    const { text, calls } = leakGuard.flush();
    forwardText(text);
    for (const c of calls) dispatchLeakedCall(c);
  };
  return { relayLeakText, flushLeak, leakedCalls };
}

function toolInFlight(state) {
  return state.pendingCalls?.size > 0 || state.toolTracker?.items?.size > 0 || state.toolInFlight === true;
}

export function pendingToolUseFor(state, leakedCalls) {
  return (
    state.emittedToolCall === true ||
    leakedCalls.length > 0 ||
    (state.pendingCalls && state.pendingCalls.size > 0) ||
    (Array.isArray(state.toolCalls) && state.toolCalls.length > 0) ||
    (state.toolTracker && state.toolTracker.items.size > 0) ||
    state.toolInFlight === true
  );
}

// Partial-final recovery: attach streamed partial state so a wedged FINAL
// no-tool summary can be accepted as partial-final success.
export function attachPartialState(err, state, leakedCalls) {
  try {
    err.partialContent = state.content || '';
    err.pendingToolUse = pendingToolUseFor(state, leakedCalls);
    err.partialModel = state.model || undefined;
  } catch {
    /* best-effort */
  }
}

// Canonical stream-outcome stamp for EVERY reject path of the Responses
// consumer — identical contract to the Chat consumer. Without it a failure
// is "unknown" to the replay gates and an upstream retry / transport
// fallback / non-streaming reset could duplicate exposed output.
export function createResponsesOutcomeStamper(state, leakedCalls) {
  return (err, extra = {}) => {
    try {
      stampStreamOutcome(err, {
        transport: STREAM_TRANSPORTS.SSE,
        provider: 'openai-compat-responses',
        terminalObserved: state.completed === true,
        continuation: state.completed !== true,
        textEmitted: state.emittedText === true,
        textObservedChars: (state.content || '').length,
        reasoningEmitted: state.emittedReasoning === true,
        toolCallsStarted: state.toolCalls.length > 0 || leakedCalls.length > 0 || toolInFlight(state),
        toolCallsComplete: state.toolCalls.length + leakedCalls.length,
        toolCallsDispatched: state.emittedToolCall === true ? Math.max(1, state.emittedToolCallKeys?.size || 0) : 0,
        pendingToolInput: toolInFlight(state),
        ...extra,
      });
    } catch {
      /* stamping is best-effort */
    }
    return err;
  };
}

/** A streamed function_call whose id/name never arrived cannot be dispatched. */
export function unresolvedSalvageError(state) {
  const unresolved = state.toolCalls.find((t) => t._pendingItemId);
  if (!unresolved) return null;
  return new Error(
    `xAI Responses stream function_call salvage failed: missing call_id/name for item_id=${unresolved._pendingItemId || '?'}`
  );
}

export function finalizeResponsesStream(state, { leakedCalls, parseResponsesToolCalls, responseOutputText, label }) {
  const response = state.completedResponse || {
    id: state.responseId || null,
    model: state.model || null,
    output_text: state.content,
    output: [],
  };
  let toolCalls = state.toolCalls.length
    ? state.toolCalls.map(({ _pendingItemId, ...t }) => t)
    : parseResponsesToolCalls(response, label);
  // Fold recovered leaked calls in (already emitted via onToolCall above).
  // Dedupe by name+args so an identical native+synthetic pair can't run twice.
  if (leakedCalls.length) {
    toolCalls = dedupeToolCallList([...(Array.isArray(toolCalls) ? toolCalls : []), ...leakedCalls]);
  }
  return {
    response,
    content: state.content || responseOutputText(response),
    toolCalls,
    model: state.model || response.model || null,
    responseId: state.responseId || response.id || null,
    stopReason: state.stopReason || null,
  };
}
