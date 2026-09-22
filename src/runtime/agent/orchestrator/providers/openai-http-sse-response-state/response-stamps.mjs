/**
 * openai-http-sse-response-state/response-stamps.mjs — everything an error
 * leaving the HTTP/SSE stream carries: the canonical stream-outcome hints,
 * the retry-safety invariants (live text emitted, tool call dispatched), the
 * provider replay, the stall partial, and the EOF-without-terminal error.
 *
 * One hint builder feeds every reject path, so no error can escape with an
 * unstamped (fail-closed "unknown") outcome.
 */
import { stampStreamOutcome, STREAM_TRANSPORTS } from '../lib/stream-outcome.mjs';
import { createProviderReplay } from '../lib/provider-replay.mjs';
import { LABEL, toolInputPending } from './response-state.mjs';

export function createResponseStamps({ state }) {
  const stampToolSafety = (err) => {
    if (state.emittedToolCall && err) {
      try {
        err.emittedToolCall = true;
        err.unsafeToRetry = true;
      } catch {}
    }
    return err;
  };
  // Canonical stream-outcome contract for the HTTP/SSE transport. ONE hint
  // builder is shared by the mid-stream catch and by every post-loop reject
  // so no reject path can escape unstamped (an unstamped outcome is
  // "unknown", which the consumers treat as fail-closed).
  const outcomeHints = (extra = {}) => ({
    transport: STREAM_TRANSPORTS.HTTP_SSE,
    provider: 'openai-responses',
    terminalObserved: state.completed === true,
    continuation: state.completed !== true,
    textEmitted: state.emittedText === true,
    textObservedChars: state.content.length,
    reasoningEmitted: state.emittedReasoning === true || state.reasoningItems.length > 0,
    toolCallsStarted: toolInputPending(state) || state.toolCalls.length > 0,
    toolCallsComplete: state.toolCalls.length,
    toolCallsDispatched: state.emittedToolCallIds.size,
    pendingToolInput: toolInputPending(state),
    // Protocol distinction: a terminal frame carrying end_turn=false keeps
    // the SAME user turn open — terminal observed, still a continuation.
    ...(state.endTurn === false ? { continuationDeclared: true } : {}),
    ...extra,
  });
  const stampOutcome = (err, extra = {}) => {
    try {
      stampStreamOutcome(err, outcomeHints(extra));
    } catch {
      /* best-effort */
    }
    return err;
  };

  // Streamed partial state attached to a semantic-idle stall.
  const stallPartial = () => ({
    emittedToolCall: state.emittedToolCallIds.size > 0,
    content: state.content,
    toolCalls: state.toolCalls.length ? state.toolCalls.slice() : undefined,
    pendingToolUse:
      state.pendingCalls.size > 0 ||
      state.emittedToolCallIds.size > 0 ||
      state.toolTracker.items.size > 0 ||
      state.toolInFlight === true,
    model: state.model || undefined,
  });
  // Every error leaving the stream loop carries the replay, the exposure
  // invariants and the canonical outcome record (same shape as the WS path).
  const stampStreamError = (err) => {
    if (err && !err.partialProviderReplay) {
      try {
        err.partialProviderReplay = createProviderReplay('openai-responses', state.responseItems);
      } catch {}
    }
    // Live-text invariant: once a non-empty chunk has been relayed it
    // cannot be withdrawn — flag the error so no upstream layer retries.
    if (state.emittedText && err) {
      try {
        err.liveTextEmitted = true;
        err.unsafeToRetry = true;
      } catch {}
    }
    // Tool-emit invariant: an error after a dispatched tool call must not
    // reissue the turn (double-execution).
    stampToolSafety(err);
    stampOutcome(err);
    return err;
  };

  // EOF without a terminal frame is ALWAYS a failure, regardless of how much
  // partial text or how many tool calls were streamed. The turn has no
  // terminal signal, so it is a continuation: returning it would report an
  // unfinished sample as a completed assistant turn (and, with tool calls
  // already dispatched, a half-finished side-effecting turn). The partial
  // rides on the error for interrupted-turn persistence.
  const endedEarlyError = () => {
    const err = stampToolSafety(
      new Error(
        `${LABEL} ended before response.completed (text=${state.content.length} chars, toolCalls=${state.toolCalls.length})`
      )
    );
    try {
      err.partialContent = state.content;
      err.partialToolCalls = state.toolCalls.length ? state.toolCalls.slice() : undefined;
      err.partialProviderReplay = createProviderReplay('openai-responses', state.responseItems);
      err.partialModel = state.model || undefined;
      err.pendingToolUse = toolInputPending(state);
    } catch {
      /* best-effort enrichment */
    }
    return stampOutcome(err, { terminalObserved: false, continuation: true });
  };

  return { stampToolSafety, stampOutcome, stallPartial, stampStreamError, endedEarlyError };
}
