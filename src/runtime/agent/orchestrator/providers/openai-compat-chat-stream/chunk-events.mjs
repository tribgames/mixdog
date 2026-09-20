/**
 * openai-compat-chat-stream/chunk-events.mjs — applying one chat-completions
 * chunk to the stream state: identity, role, text (through the leak guard),
 * reasoning aliases, tool_calls deltas, finish reason and usage.
 */
import { mergeToolCallDelta } from './tool-call-acc.mjs';
import { appendText, relayText, reportProgress, reportTransport } from './stream-state.mjs';

function applyReasoning(state, delta) {
  if (Array.isArray(delta?.reasoning_details) && delta.reasoning_details.length) {
    state.reasoningDetails.push(...delta.reasoning_details);
    reportProgress(state, 'reasoning');
  }
  // These provider fields are aliases, never independent text segments.
  const reasoningDelta =
    [delta?.reasoning_content, delta?.reasoning, delta?.thinking].find((value) => typeof value === 'string') ?? null;
  if (reasoningDelta === null) return;
  state.sawReasoningContent = true;
  state.reasoningContent += reasoningDelta;
  if (reasoningDelta) {
    state.emittedReasoning = true;
    reportProgress(state, 'reasoning');
  }
}

export function applyCompatChunk(state, chunk) {
  reportTransport(state);
  if (chunk?.id) state.responseId = chunk.id;
  if (chunk?.model) state.model = chunk.model;
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta;
  if (typeof delta?.role === 'string' && delta.role) {
    reportProgress(state, 'semantic');
  }
  if (delta?.content) {
    if (state.leakGuard.enabled) relayText(state, delta.content);
    else appendText(state, delta.content);
  }
  applyReasoning(state, delta);
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length) {
    reportProgress(state, 'tool');
  }
  mergeToolCallDelta(state.toolAcc, delta?.tool_calls);
  if (choice?.finish_reason) state.stopReason = choice.finish_reason;
  if (chunk?.usage) state.rawUsage = chunk.usage;
}
