/**
 * openai-compat-chat-stream/stream-result.mjs — settling a finished
 * chat-completions stream: the no-event / no-finish_reason rejections, the
 * reconstructed response, tool-call parsing and dispatch, and the result.
 */
import { dedupeToolCallList } from '../anthropic-leaked-toolcall.mjs';
import { truncatedCompatStreamError } from '../lib/openai-tool-args.mjs';
import {
  emitCompatToolCallOnce,
  firstByteCompatStreamError,
  markErrorLiveTextEmitted,
  markUnsafeRetryIfToolEmitted,
} from '../openai-compat-stream-common.mjs';
import { orderedToolCalls, toolCallsFromStreamAcc } from './tool-call-acc.mjs';
import { attachPartial, stampCompatOutcome } from './stream-state.mjs';

/** Rejection for a stream that ended without a terminal event. */
export function incompleteStreamError(state, label) {
  if (!state.sawFirstEvent) return stampCompatOutcome(state, firstByteCompatStreamError(label));
  const err = truncatedCompatStreamError(label, 'no finish_reason');
  if (state.emittedText) {
    markErrorLiveTextEmitted(err);
    try {
      err.streamStalled = true;
    } catch {
      /* best-effort */
    }
    attachPartial(state, err);
  }
  return stampCompatOutcome(state, markUnsafeRetryIfToolEmitted(err, state.streamEmitState));
}

function buildResponse(state) {
  const message = {
    content: state.content || null,
    ...(state.sawReasoningContent ? { reasoning_content: state.reasoningContent } : {}),
    ...(state.reasoningDetails.length ? { reasoning_details: state.reasoningDetails } : {}),
  };
  const rawToolCalls = orderedToolCalls(state.toolAcc).filter((tc) => tc.id || tc.function?.name);
  if (rawToolCalls.length) message.tool_calls = rawToolCalls;
  return {
    id: state.responseId || null,
    model: state.model || null,
    choices: [{ message, finish_reason: state.stopReason }],
    usage: state.rawUsage || undefined,
  };
}

function parseAccumulatedToolCalls(state, { label, parseToolCalls }) {
  try {
    return toolCallsFromStreamAcc(state.toolAcc, parseToolCalls, label, state.stopReason);
  } catch (err) {
    if (state.stopReason && err.truncatedStream) {
      try {
        err.message += ` finish_reason=${state.stopReason}`;
      } catch {}
    }
    if (state.emittedText) markErrorLiveTextEmitted(err);
    throw stampCompatOutcome(state, markUnsafeRetryIfToolEmitted(err, state.streamEmitState));
  }
}

export function settleCompatStream(state, { label, parseToolCalls }) {
  const response = buildResponse(state);
  let toolCalls = parseAccumulatedToolCalls(state, { label, parseToolCalls });
  if (Array.isArray(toolCalls) && toolCalls.length) {
    for (const call of toolCalls) emitCompatToolCallOnce(state.streamEmitState, call, state.onToolCall);
  }
  if (state.leakedCalls.length) {
    toolCalls = dedupeToolCallList([...(Array.isArray(toolCalls) ? toolCalls : []), ...state.leakedCalls]);
  }
  return {
    response,
    model: state.model,
    content: state.content,
    toolCalls,
    stopReason: state.stopReason,
    reasoningContent: state.sawReasoningContent ? state.reasoningContent : null,
    reasoningDetails: state.reasoningDetails.length ? state.reasoningDetails : null,
    rawUsage: state.rawUsage,
  };
}
