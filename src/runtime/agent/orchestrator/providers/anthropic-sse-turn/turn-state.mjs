/**
 * anthropic-sse-turn/turn-state.mjs — the explicit record one Anthropic SSE
 * turn accumulates: streamed text, model, usage, stop info, dispatched
 * client tool calls, fallback events and the terminal-frame flag. Every
 * module of the turn reads and writes this one object; nothing about the
 * turn's progress is hidden in a closure.
 */

export function createAnthropicTurnState() {
  return {
    content: '',
    model: '',
    hasThinkingContent: false,
    contentBlockTypes: new Set(),
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, raw: null },
    stopReason: null,
    stopDetails: undefined,
    fallbackEvents: [],
    // Set when a terminal frame (message_delta stop_reason / message_stop)
    // arrived while tool input was still in flight — used only to word the
    // truncated-stream failure precisely.
    sawTerminalFrameWithPendingInput: false,
  };
}

// Final usage can revise any slot. Omitted fields preserve the earlier
// report; explicit zero replaces it. Update before terminal early exits.
export function updateTurnUsage(usage, raw) {
  if (raw.input_tokens != null) usage.inputTokens = raw.input_tokens;
  if (raw.output_tokens != null) usage.outputTokens = raw.output_tokens;
  if (raw.cache_read_input_tokens != null) usage.cachedTokens = raw.cache_read_input_tokens;
  if (raw.cache_creation_input_tokens != null) usage.cacheWriteTokens = raw.cache_creation_input_tokens;
  // The 1-hour-TTL share of cache writes, priced separately.
  if (raw.cache_creation?.ephemeral_1h_input_tokens != null) {
    usage.cacheWrite1hTokens = raw.cache_creation.ephemeral_1h_input_tokens;
  }
  usage.raw = { ...(usage.raw || {}), ...raw };
  // Input excludes cache; all three slots contribute to prompt volume.
  usage.promptTokens = usage.inputTokens + usage.cachedTokens + usage.cacheWriteTokens;
}
