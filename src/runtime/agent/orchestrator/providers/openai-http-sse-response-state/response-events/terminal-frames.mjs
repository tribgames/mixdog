/**
 * response-events/terminal-frames.mjs — the frames that end a Responses
 * stream: response.completed (usage + completed-output bundle),
 * response.incomplete (max-output cutoff vs. failure), response.done, and the
 * typed wire errors for response.failed / error.
 */
import { typedStatusFrom } from '../../retry-classifier.mjs';
import {
  endTurnFromEvent,
  incompleteReasonFromEvent,
  isMaxOutputIncompleteReason,
} from '../../lib/responses-terminal-fields.mjs';
import { LABEL, toolInputPending } from '../response-state.mjs';
import { usageFromResponse } from '../response-outcome.mjs';

// Typed status only — nothing is synthesized from text. The frame itself is
// preserved so the wire-error default-retry classification applies (fatal
// codes stay terminal).
function wireFailureError(message, event, detail, typedSources) {
  const err = new Error(message);
  err.responseFailed = event;
  const typed = typedStatusFrom(...typedSources);
  if (typed) err.httpStatus = typed;
  const code = detail?.code ?? detail?.type ?? null;
  if (typeof code === 'string' && code) err.providerErrorCode = code;
  return err;
}

export function createTerminalFrameEvents({ state, items, text, outcome, meaningful }) {
  // The completed-output bundle: absorb every item (text through the leak
  // guard, calls through the collectors) and report progress once.
  const absorbCompletedOutput = (output) => {
    let reported = false;
    for (const item of output) {
      items.pushResponseItem(item);
      if (item.type === 'message') {
        if (text.absorbCompletedMessage(item)) reported = true;
        continue;
      }
      if (item.type === 'reasoning') items.pushReasoningItem(item);
      else if (item.type === 'web_search_call') items.pushWebSearchCall(item);
      else if (item.type === 'tool_search_call') items.pushToolSearchCall(item);
      else if (item.type === 'custom_tool_call') items.pushCustomToolCall(item);
      else if (item.type === 'function_call') items.absorbCompletedFunctionCall(item);
      else continue;
      meaningful(item.type === 'reasoning' ? 'reasoning' : 'tool');
      reported = true;
    }
    return reported;
  };
  const setEndTurn = (event) => {
    const wireEndTurn = endTurnFromEvent(event);
    if (typeof wireEndTurn === 'boolean') state.endTurn = wireEndTurn;
  };

  const onCompleted = (event) => {
    const resp = event.response || {};
    state.serviceTier = resp.service_tier || resp.serviceTier || state.serviceTier;
    if (!state.model && resp.model) state.model = resp.model;
    if (!state.responseId && resp.id) state.responseId = resp.id;
    if (resp.usage) state.usage = usageFromResponse(resp.usage, state.serviceTier);
    if (!absorbCompletedOutput(resp.output || [])) meaningful('semantic');
    state.completed = true;
    setEndTurn(event);
  };

  // Max-output cutoff with a function/custom/tool_search still in flight
  // means the tool arguments were truncated — do NOT mark a clean completion
  // (mirrors the compat Responses path), or partial args surface as a
  // successful tool call. Throw a stream-stalled pendingToolUse error so the
  // loop gates/retries.
  const onIncomplete = (event, frame) => {
    const reason = incompleteReasonFromEvent(event);
    if (!isMaxOutputIncompleteReason(reason)) throw new Error(`${LABEL} ${frame}: ${reason}`);
    if (toolInputPending(state)) {
      const err = outcome.stampToolSafety(new Error(`${LABEL} ${frame} (max_output_tokens) with tool call in flight`));
      err.streamStalled = true;
      err.pendingToolUse = true;
      err.partialContent = state.content;
      err.partialModel = state.model || undefined;
      throw err;
    }
    state.completed = true;
    state.stopReason = 'length';
  };

  const onDone = (event) => {
    if (!event.response || event.response.status === 'completed') {
      state.completed = true;
      // Terminal success frame for streams that never emit a separate
      // response.completed — same optional end_turn.
      setEndTurn(event);
    } else if (event.response.status === 'failed') {
      const msg = event.response?.error?.message || 'response.done failed';
      const err = new Error(`${LABEL} response.done failed: ${msg}`);
      const typed = typedStatusFrom(event.response?.error, event.error, event);
      if (typed) err.httpStatus = typed;
      throw err;
    } else if (event.response.status === 'incomplete') {
      onIncomplete(event, 'response.done incomplete');
    }
  };

  const failedFrameError = (event) =>
    wireFailureError(
      `${LABEL} response.failed: ${event.response?.error?.message || event.error?.message || event.message || 'response.failed'}`,
      event,
      event.response?.error || event.error || null,
      [event.response?.error, event.error, event]
    );

  // Same wire-error contract as response.failed.
  const errorFrameError = (event) =>
    wireFailureError(
      `${LABEL} error: ${event.message || event.error?.message || 'unknown'}`,
      event,
      { code: event.error?.code ?? event.error?.type ?? event.code ?? null },
      [event.error, event]
    );

  return { onCompleted, onIncomplete, onDone, failedFrameError, errorFrameError };
}
