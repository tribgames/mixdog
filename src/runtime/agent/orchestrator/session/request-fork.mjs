// request-fork.mjs — a cache-sharing fork of a provider request the main loop
// already sent (side-question-store.mjs): its messages unchanged, then the
// reply that request produced and one appended user turn. Reusing the saved
// send options keeps the model, system prompt, tools and cache-relevant
// options identical, so the provider's prompt cache serves the prefix.
import { collectAssistantToolCallIds } from './context-tool-pairs.mjs';
import { buildIntermediateAssistantMessage, buildToolCallAssistantMessage } from './loop/assistant-commit.mjs';

// The assistant turn the saved request produced, built the way the loop
// commits it (without the turn's one-shot transcript metadata), plus a stub
// result per tool call: the fork only needs each call answered so the
// request stays well-formed.
function replyMessages(response, toolStub) {
  if (!response) return [];
  const reply = response.toolCalls?.length
    ? buildToolCallAssistantMessage(response, { calls: response.toolCalls, opts: {} })
    : buildIntermediateAssistantMessage(response, {});
  if (!reply) return [];
  const stubs = collectAssistantToolCallIds(reply).map((id) => ({ role: 'tool', toolCallId: id, content: toolStub }));
  return [reply, ...stubs];
}

/**
 * The fork of a saved request with `prompt` as its final user turn. The
 * provider continuation state follows the reply when it is appended, exactly
 * as the main loop's next request would carry it. `sharedCachePrefixCount`
 * (the shared prefix's message count, which survives model-proxy
 * serialization) keeps an Anthropic message breakpoint on the shared prefix,
 * so the fork reads the saved request's cache entry and writes none for its
 * suffix.
 */
export function buildForkedRequest(request, prompt, toolStub) {
  const reply = replyMessages(request.response, toolStub);
  const opts = { ...request.opts };
  if (reply.length && Object.hasOwn(request.response, 'providerState')) {
    opts.providerState = request.response.providerState;
  }
  if (request.messages.length) opts.sharedCachePrefixCount = request.messages.length;
  const messages = [
    ...request.messages,
    ...reply,
    // A user interjection keeps its own turn (never folded into a preceding
    // tool result), so the prefix's last block reaches the provider unchanged.
    { role: 'user', content: prompt, meta: { source: 'steering' } },
  ];
  return { messages, opts };
}
