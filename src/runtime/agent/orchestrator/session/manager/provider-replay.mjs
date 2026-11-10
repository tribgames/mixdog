// Provider-native replay state on transcript messages: reasoning items,
// thinking blocks with their signatures, ordered native blocks, Gemini thought
// signatures on tool calls. It belongs to the provider (and the account) that
// produced it — another provider rejects it or, worse, a gateway of the same
// family validates it against its own key. A route change drops it; what the
// next provider needs (text, tool calls and their results, in order) stays,
// and each adapter rebuilds its own wire shape from that.

// Every message field a provider adapter replays or re-reads as native state.
const PROVIDER_REPLAY_FIELDS = [
  'providerReplay',
  'reasoning',
  'thinkingBlocks',
  'assistantBlocks',
  'reasoningItems',
  'reasoningContent',
  'providerMetadata',
];
// Opaque provider tokens a tool call may carry (Gemini thought signatures).
const TOOL_CALL_SIGNATURE_FIELDS = ['thoughtSignature', 'thought_signature'];

const hasAny = (value, fields) => fields.some((field) => field in value);

function plainToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.some((call) => call && hasAny(call, TOOL_CALL_SIGNATURE_FIELDS))) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (!call || !hasAny(call, TOOL_CALL_SIGNATURE_FIELDS)) return call;
    const plain = { ...call };
    for (const field of TOOL_CALL_SIGNATURE_FIELDS) delete plain[field];
    return plain;
  });
}

/** The provider-native replay state `message` carries — its replay fields'
 *  values and its tool calls' signatures — or null when it carries none. */
export function providerReplayState(message) {
  if (!message || typeof message !== 'object') return null;
  const state = PROVIDER_REPLAY_FIELDS.filter((field) => field in message).map((field) => message[field]);
  for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
    if (call && typeof call === 'object') {
      for (const field of TOOL_CALL_SIGNATURE_FIELDS) if (field in call) state.push(call[field]);
    }
  }
  return state.length ? state : null;
}

/** `message` without provider-native replay state; the same object when it carries none. */
export function stripProviderReplayMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const toolCalls = plainToolCalls(message.toolCalls);
  if (!hasAny(message, PROVIDER_REPLAY_FIELDS) && toolCalls === message.toolCalls) return message;
  const plain = { ...message };
  for (const field of PROVIDER_REPLAY_FIELDS) delete plain[field];
  if (toolCalls !== message.toolCalls) plain.toolCalls = toolCalls;
  return plain;
}

/** Replace, never mutate: delta saves see rewritten messages as changed. */
export function stripProviderReplayMessages(messages) {
  return Array.isArray(messages) ? messages.map(stripProviderReplayMessage) : messages;
}
