/**
 * openai-ws-events.mjs — usage assembly + event/close parsing helpers for the
 * OpenAI OAuth WebSocket transport.
 *
 * The pure,
 * socket-free helpers used by the _streamResponse loop to parse server event
 * frames, derive incomplete reasons, and map WS close codes to HTTP status.
 * openai-ws-stream.mjs re-exports these so existing importers resolve
 * unchanged.
 */

export function _parseEvent(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function _httpStatusFromWsClose(code, reason) {
  const n = Number(code || 0);
  const r = String(reason || '').toLowerCase();
  if (
    n === 4401 ||
    /\b(?:unauthorized|unauthorised|authentication|auth(?:enticated?)?|not authenticated|token expired|access token)\b/.test(
      r
    )
  ) {
    return 401;
  }
  if (n === 4403 || /\b(?:forbidden|policy|permission denied)\b/.test(r)) return 403;
  if (n === 4429 || /\b(?:rate limit|quota)\b/.test(r)) return 429;
  return 0;
}
