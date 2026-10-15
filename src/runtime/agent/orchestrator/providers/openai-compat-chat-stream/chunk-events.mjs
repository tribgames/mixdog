/**
 * openai-compat-chat-stream/chunk-events.mjs — applying one chat-completions
 * chunk to the stream state: identity, role, text (through the leak guard),
 * reasoning aliases, tool_calls deltas, finish reason and usage.
 */
import { mergeToolCallDelta } from './tool-call-acc.mjs';
import { appendText, drainLeakedCalls, relayText, reportProgress, reportTransport } from './stream-state.mjs';
import { chatContentParts } from '../openai-compat-reasoning-field.mjs';

function appendReasoning(state, text, source) {
  state.sawReasoningContent = true;
  state.reasoningSource = source;
  state.reasoningContent += text;
  if (text) {
    state.emittedReasoning = true;
    reportProgress(state, 'reasoning');
  }
}

function applyReasoning(state, delta) {
  if (Array.isArray(delta?.reasoning_details) && delta.reasoning_details.length) {
    state.reasoningDetails.push(...delta.reasoning_details);
    reportProgress(state, 'reasoning');
  }
  // These provider fields are aliases, never independent text segments.
  const source = ['reasoning_content', 'reasoning', 'thinking'].find((key) => typeof delta?.[key] === 'string');
  if (source === undefined) return;
  appendReasoning(state, delta[source], source);
}

function applyContent(state, content) {
  if (state.leakGuard.enabled) relayText(state, content);
  else appendText(state, content);
}

// Mistral-style typed chunk lists: thinking → reasoning, text → assistant
// text, applied in arrival order.
function applyContentParts(state, parts) {
  for (const part of parts) {
    if (part.kind === 'reasoning') appendReasoning(state, part.text, 'content_chunks');
    else if (part.text) applyContent(state, part.text);
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
  const contentParts = chatContentParts(delta?.content);
  if (contentParts) applyContentParts(state, contentParts);
  else if (delta?.content) applyContent(state, delta.content);
  applyReasoning(state, delta);
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length) {
    reportProgress(state, 'tool');
  }
  mergeToolCallDelta(state.toolAcc, delta?.tool_calls);
  if (choice?.finish_reason) {
    state.stopReason = choice.finish_reason;
    drainLeakedCalls(state);
  }
  if (chunk?.usage) state.rawUsage = chunk.usage;
}
