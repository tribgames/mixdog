// Assistant-turn history commits for the agent loop. Two turns are committed
// from the loop: the intermediate/continuation turn (no client tool calls) and
// the tool-call turn. Both must hand the provider its own verbatim replay
// payloads back on the next request under the SAME precedence rules, so the
// rules live here once instead of in two copies that can drift.
import { cloneProviderReplay } from '../../providers/lib/provider-replay.mjs';
import { compactToolCallsForHistory } from './stored-tool-args.mjs';

// ask-session supplies a one-shot metadata taker per committed assistant turn;
// absence (direct adapter callers, tests) leaves the message untouched.
function attachAssistantTranscriptMetadata(message, opts = {}) {
  const transcript =
    typeof opts.takeAssistantTranscriptMetadata === 'function' ? opts.takeAssistantTranscriptMetadata() : null;
  if (!transcript) return message;
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
  return { ...message, meta: { ...meta, transcript } };
}

// Verbatim provider payloads carried by an assistant history message, in
// precedence order:
//   - providerReplay — a complete provider-native turn record. It already
//     contains every block, so no other echo field is stored alongside it.
//   - assistantBlocks — Anthropic's ordered block list (text / thinking /
//     server_tool_use / *_tool_result / tool_use). These blocks exist ONLY in
//     this list, cannot be rebuilt from the flattened fields, and are
//     order-bound (a result block is valid only right after its call block).
//     They already hold the thinking blocks verbatim, so thinkingBlocks is
//     skipped when they are present — a second copy would be double-counted by
//     the context estimator.
//   - thinkingBlocks — Anthropic adaptive thinking: prior-turn blocks must be
//     replayed with their signature intact before the next tool_use turn.
//   - reasoningItems — OpenAI Responses encrypted_content replay items, which
//     keep the openai-oauth server-side cache prefix stable.
// `keepAssistantBlocks` is false for the intermediate committer: a MIXED turn
// (native blocks + client tool_use) belongs to the tool-call committer, which
// keeps both the blocks and the compacted toolCalls.
function assistantEchoPayloads(resp, { keepAssistantBlocks }) {
  return {
    providerReplay: cloneProviderReplay(resp.providerReplay),
    assistantBlocks:
      keepAssistantBlocks && Array.isArray(resp.assistantBlocks) && resp.assistantBlocks.length
        ? resp.assistantBlocks
        : null,
    thinkingBlocks: Array.isArray(resp.thinkingBlocks) && resp.thinkingBlocks.length ? resp.thinkingBlocks : null,
    reasoningItems: Array.isArray(resp.reasoningItems) && resp.reasoningItems.length ? resp.reasoningItems : null,
    reasoningContent: typeof resp.reasoningContent === 'string' ? resp.reasoningContent : undefined,
    providerMetadata: resp.providerMetadata && typeof resp.providerMetadata === 'object' ? resp.providerMetadata : null,
  };
}

// Providers that do not understand a field simply drop it, so the same spread
// is safe for every adapter.
function assistantEchoFields(payloads) {
  const { providerReplay, assistantBlocks, thinkingBlocks, reasoningItems } = payloads;
  return {
    ...(providerReplay ? { providerReplay } : {}),
    ...(assistantBlocks && !providerReplay ? { assistantBlocks } : {}),
    ...(thinkingBlocks && !assistantBlocks && !providerReplay ? { thinkingBlocks } : {}),
    ...(reasoningItems && !providerReplay ? { reasoningItems } : {}),
    ...(payloads.reasoningContent !== undefined ? { reasoningContent: payloads.reasoningContent } : {}),
    ...(payloads.providerMetadata ? { providerMetadata: payloads.providerMetadata } : {}),
  };
}

// Intermediate (non-tool) assistant turn: max-output partials, refusal
// narration, provider continuations, and the terminal turn committed before a
// steering drain. Returns null when the turn carries nothing committable — a
// native-only turn (server tool blocks, no flattened text) is real output and
// stays committable.
export function buildIntermediateAssistantMessage(resp, opts) {
  if (!resp) return null;
  let content = '';
  if (typeof resp.content === 'string') content = resp.content;
  else if (resp.content != null) content = String(resp.content);
  const payloads = assistantEchoPayloads(resp, { keepAssistantBlocks: !resp.toolCalls?.length });
  if (
    !content &&
    !payloads.reasoningContent &&
    !payloads.reasoningItems &&
    !payloads.thinkingBlocks &&
    !payloads.assistantBlocks &&
    !payloads.providerReplay
  )
    return null;
  const stopReason = resp.stopReason ?? resp.stop_reason ?? null;
  const terminationReason = resp.terminationReason ?? null;
  return attachAssistantTranscriptMetadata(
    {
      role: 'assistant',
      content,
      ...assistantEchoFields(payloads),
      ...(stopReason ? { stopReason } : {}),
      ...(terminationReason ? { terminationReason } : {}),
    },
    opts
  );
}

// Tool-call assistant turn. `toolCalls` stays authoritative for execution,
// recovery, and interruption; deferBodies keeps mutation bodies verbatim for
// the rest of the session (collapsing them later rewrote an already-cached
// prefix and re-billed the request uncached).
export function buildToolCallAssistantMessage(response, { calls, suppressMidTurnText, opts }) {
  return attachAssistantTranscriptMetadata(
    {
      role: 'assistant',
      createdAt: Date.now(),
      // Sub-agent tool-call turns carry only mid-turn preamble in
      // response.content (the real result rides the later final-answer
      // turn). Blank it so it never accumulates as input tokens.
      content: suppressMidTurnText ? '' : response.content || '',
      toolCalls: compactToolCallsForHistory(calls, { deferBodies: true }),
      ...assistantEchoFields(assistantEchoPayloads(response, { keepAssistantBlocks: true })),
    },
    opts
  );
}

export function commitAssistantMessage(messages, message, opts) {
  messages.push(message);
  try {
    opts?.onAssistantMessageCommitted?.(message);
  } catch {
    /* best-effort host hook */
  }
  return message;
}
