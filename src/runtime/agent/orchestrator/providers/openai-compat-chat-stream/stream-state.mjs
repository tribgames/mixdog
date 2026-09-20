/**
 * openai-compat-chat-stream/stream-state.mjs — one chat-completions stream's
 * explicit state: accumulated text/reasoning/tool calls, exposure flags the
 * retry gates read, the semantic idle deadline, and the leak guard that
 * rescues tool calls printed as text.
 */
import { stampStreamOutcome, STREAM_TRANSPORTS } from '../lib/stream-outcome.mjs';
import { createLeakGuard, createToolCallDedupe } from '../anthropic-leaked-toolcall.mjs';
import { emitCompatToolCallOnce, synthLeakedOpenAICall } from '../openai-compat-stream-common.mjs';
import { createToolCallAccumulator } from './tool-call-acc.mjs';

export function createCompatStreamState({ knownToolNames, idleMs, onStreamDelta, onToolCall, onTextDelta }) {
  const toolDedupe = createToolCallDedupe();
  const state = {
    idleMs,
    onStreamDelta,
    onToolCall,
    onTextDelta,
    semanticIdleDeadlineAt: 0,
    sawFirstEvent: false,
    content: '',
    reasoningContent: '',
    sawReasoningContent: false,
    reasoningDetails: [],
    // Both text and reasoning exposure prohibit resampling the request.
    emittedText: false,
    emittedReasoning: false,
    model: '',
    responseId: '',
    stopReason: null,
    rawUsage: null,
    toolAcc: createToolCallAccumulator(),
    streamEmitState: { emittedToolCallKeys: new Set(), emittedToolCall: false, _toolDedupe: toolDedupe },
    leakGuard: createLeakGuard({ knownToolNames, harmony: true }),
    leakedCalls: [],
  };
  return state;
}

export function reportTransport(state) {
  try {
    state.onStreamDelta?.('transport');
  } catch {}
}

export function reportProgress(state, kind) {
  if (kind !== 'transport') state.semanticIdleDeadlineAt = Date.now() + state.idleMs;
  try {
    state.onStreamDelta?.(kind);
  } catch {}
}

/** Text the model exposed: accumulate, refresh the idle deadline, relay live. */
export function appendText(state, text) {
  state.content += text;
  reportProgress(state, 'text');
  if (state.onTextDelta) {
    state.emittedText = true;
    try {
      state.onTextDelta(text);
    } catch {}
  }
}

function dispatchLeakedCall(state, recovered) {
  const call = synthLeakedOpenAICall(recovered);
  emitCompatToolCallOnce(state.streamEmitState, call, state.onToolCall);
  reportProgress(state, 'tool');
  return call;
}

function relayGuarded(state, { text, calls }) {
  if (text) appendText(state, text);
  for (const c of calls) state.leakedCalls.push(dispatchLeakedCall(state, c));
}

/** Route a text delta through the leak guard, dispatching rescued calls. */
export function relayText(state, delta) {
  relayGuarded(state, state.leakGuard.push(delta));
}

export function flushLeak(state) {
  relayGuarded(state, state.leakGuard.flush());
}

export function pendingToolUse(state) {
  return state.toolAcc.byKey.size > 0 || state.leakedCalls.length > 0;
}

export function toolWorkStarted(state) {
  return state.streamEmitState.emittedToolCall || state.toolAcc.byKey.size > 0;
}

/** Keep exposed partial output on the error for upstream salvage. */
export function attachPartial(state, err) {
  try {
    err.partialContent = state.content;
    err.pendingToolUse = pendingToolUse(state);
    err.partialModel = state.model || undefined;
  } catch {
    /* best-effort */
  }
}

// Every rejection carries the exposure evidence used by upstream retry gates.
export function stampCompatOutcome(state, err, extra = {}) {
  const toolAccSize = state.toolAcc.byKey.size;
  try {
    stampStreamOutcome(err, {
      transport: STREAM_TRANSPORTS.SSE,
      provider: 'openai-compat',
      terminalObserved: !!state.stopReason,
      continuation: !state.stopReason,
      textEmitted: state.emittedText === true,
      textObservedChars: state.content.length,
      reasoningEmitted: state.emittedReasoning === true || state.reasoningContent.length > 0,
      toolCallsStarted: toolAccSize > 0 || state.leakedCalls.length > 0,
      toolCallsComplete: state.leakedCalls.length,
      toolCallsDispatched: state.streamEmitState.emittedToolCall === true ? Math.max(1, state.leakedCalls.length) : 0,
      pendingToolInput: toolAccSize > 0,
      ...extra,
    });
  } catch {
    /* stamping is best-effort */
  }
  return err;
}
