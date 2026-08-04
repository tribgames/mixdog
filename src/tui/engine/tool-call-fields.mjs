/**
 * src/tui/engine/tool-call-fields.mjs - accessors for the varied tool-call /
 * tool-result id/name/arg shapes across providers. Extracted from engine.mjs.
 */
export function toolCallId(call) {
  return call?.id ?? call?.toolCallId ?? call?.tool_call_id ?? call?.call_id;
}

export function toolResultCallId(message) {
  return message?.toolCallId
    ?? message?.tool_call_id
    ?? message?.tool_use_id
    ?? message?.call_id
    ?? message?.id;
}

export function toolCallName(call) {
  return call?.name ?? call?.function?.name ?? call?.toolName ?? call?.tool_name ?? 'tool';
}

export function toolCallArgs(call) {
  return call?.arguments ?? call?.args ?? call?.input ?? call?.function?.arguments;
}
