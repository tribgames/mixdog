/**
 * openai-http-sse-response-state/response-state.mjs — the explicit record
 * one HTTP/SSE Responses stream accumulates: text, ids, usage, tool calls
 * and their in-flight tracking, response items for replay, citations,
 * reasoning items, the terminal flags and the exposure invariants. Every
 * module of the stream reads and writes this one object.
 */
import { createActiveToolItemTracker } from '../tool-stream-state.mjs';
import { createToolCallDedupe } from '../anthropic-leaked-toolcall.mjs';

export const LABEL = 'OpenAI OAuth HTTP fallback';

export function createResponseState() {
  return {
    content: '',
    model: '',
    responseId: '',
    serviceTier: '',
    usage: null,
    toolCalls: [],
    pendingCalls: new Map(),
    // Active tool-item / alias tracking shared with the WS + compat Responses
    // streams (tool-stream-state.mjs). Mark on output_item.added / arg-input
    // deltas, clear on output_item.done; toolInFlight latches tool work the
    // moment a call's input starts streaming (before it lands in pendingCalls).
    toolTracker: createActiveToolItemTracker(),
    toolInFlight: false,
    reasoningItems: [],
    responseItems: [],
    responseItemKeys: new Set(),
    citations: [],
    citationKeys: new Set(),
    webSearchCalls: [],
    webSearchCallKeys: new Set(),
    completed: false,
    stopReason: null,
    // Normalized wire `end_turn` from the terminal frame; undefined unless the
    // server actually supplied a boolean.
    endTurn: undefined,
    // Gateway live-text relay invariant: set once a non-empty text chunk has
    // been forwarded to the client. A failure afterwards is non-retryable —
    // the rendered text cannot be withdrawn and a re-request would concatenate
    // a second attempt.
    emittedText: false,
    // Reasoning-exposure invariant: set the moment a reasoning/summary delta is
    // seen (NOT at completion, where reasoningItems is assembled). Exposed
    // reasoning is a replay boundary for retry, transport fallback and the
    // reactive compact retry.
    emittedReasoning: false,
    // Tool-emit invariant (mirrors emittedText, WS path's emittedToolCall): set
    // once onToolCall has actually dispatched a call. A failure afterwards is
    // non-retryable — the side-effecting tool already ran, and any upstream
    // retry/fallback would double-execute it. Stamped onto errors so
    // shouldFallbackTransport / the WS auth-retry gate refuse to reissue.
    emittedToolCall: false,
    // Single-emit guard: the HTTP/SSE event stream can surface the same
    // function_call across multiple frames; each unique call id fires
    // onToolCall exactly once, the first time the call is complete.
    emittedToolCallIds: new Set(),
    // Cross-path name+args dedupe. A text-leaked synthetic and an identical
    // native function_call must fire onToolCall exactly once.
    toolDedupe: createToolCallDedupe(),
  };
}

export const toolInputPending = (state) =>
  state.pendingCalls.size > 0 || state.toolTracker.items.size > 0 || state.toolInFlight === true;

// After an item resolves the latch stays set only while something is still
// open — otherwise a completed call keeps the latch and a later max-output
// cutoff is misread as a tool in flight.
export const recomputeToolInFlight = (state) => {
  state.toolInFlight = state.pendingCalls.size > 0 || state.toolTracker.items.size > 0;
};
