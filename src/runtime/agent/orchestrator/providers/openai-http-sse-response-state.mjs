/**
 * openai-http-sse-response-state.mjs — what one HTTP/SSE fallback stream
 * accumulates and how each Responses event folds into it: text (through the
 * leaked-tool-call guard), ids, usage, tool calls (native, custom,
 * tool_search, leaked), response items for replay, citations, reasoning
 * items, the exposure invariants (text / reasoning / tool emitted) and the
 * canonical stream-outcome stamps every thrown error carries.
 *
 * The stream loop (openai-oauth-http-sse.mjs) owns the socket, the watchdogs
 * and the byte framing; this wires the explicit record
 * (openai-http-sse-response-state/response-state), the item collectors
 * (response-items), the text relay + leak guard (text-relay), the event
 * switch (response-events) and the outcome projections (response-outcome).
 */
import { createResponseState } from './openai-http-sse-response-state/response-state.mjs';
import { createResponseItems } from './openai-http-sse-response-state/response-items.mjs';
import { createTextRelay } from './openai-http-sse-response-state/text-relay.mjs';
import { createResponseOutcome } from './openai-http-sse-response-state/response-outcome.mjs';
import { createResponseEvents } from './openai-http-sse-response-state/response-events.mjs';

/**
 * @param {object} deps
 * @param {object} deps.body  request body (its `tools` seed the leak guard)
 * @param {(call: object) => void} [deps.onToolCall]
 * @param {(text: string) => void} [deps.onTextDelta]
 * @param {(kind: string) => void} deps.meaningful  semantic progress (re-arms the idle watchdog)
 * @param {() => void} deps.onServerEvent  first-event → semantic-idle handover
 */
export function createHttpSseResponseState({ body, onToolCall, onTextDelta, meaningful, onServerEvent }) {
  const state = createResponseState();
  const outcome = createResponseOutcome({ state });
  const items = createResponseItems({ state, onToolCall });
  const text = createTextRelay({ state, body, onTextDelta, meaningful, emitToolCall: items.emitToolCall });
  const events = createResponseEvents({ state, items, text, outcome, meaningful, onServerEvent });

  return {
    handleEvent: events.handleEvent,
    flushLeak: text.flushLeak,
    stallPartial: outcome.stallPartial,
    stampStreamError: outcome.stampStreamError,
    finish: outcome.finish,
  };
}
