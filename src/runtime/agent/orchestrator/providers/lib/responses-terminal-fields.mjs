/**
 * lib/responses-terminal-fields.mjs — fields read off terminal Responses
 * frames, shared by the HTTP SSE and WebSocket transports.
 */

// Wire-level `end_turn` on a terminal Responses frame: an optional boolean on
// the completed response, where "false ⇒ needs follow-up". Only a real boolean
// is normalized; anything else — including a missing field — stays undefined
// so absence is preserved and no caller can mistake "server said nothing" for
// "server said true/false".
export function endTurnFromEvent(event) {
  if (!event || typeof event !== 'object') return undefined;
  const fromResponse = event.response?.end_turn;
  if (typeof fromResponse === 'boolean') return fromResponse;
  const topLevel = event.end_turn;
  if (typeof topLevel === 'boolean') return topLevel;
  return undefined;
}

export function incompleteReasonFromEvent(event) {
  const reasonObj =
    event?.response?.incomplete_details || event?.incomplete_details || event?.response?.status_details || null;
  return String(reasonObj?.reason || event?.response?.status || 'incomplete');
}

// A function/custom/tool_search call item the server cut off (status
// 'incomplete'): its arguments or input are truncated, so it is never a call
// to run or replay. The stream keeps it tracked as a tool still in flight, so
// the terminal frame reads as a pending-tool cutoff.
export function isIncompleteToolItem(item) {
  return (
    item?.status === 'incomplete' &&
    (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'tool_search_call')
  );
}

export function isMaxOutputIncompleteReason(reason) {
  return /^(?:max_output_tokens|max_tokens|length|output_token_limit)$/i.test(String(reason || '').trim());
}
