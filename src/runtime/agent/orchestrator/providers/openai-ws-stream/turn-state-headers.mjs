import { appendAgentTrace } from '../../agent-trace.mjs';
import { captureCodexTurnState } from '../openai-turn-state.mjs';

const X_CODEX_TURN_STATE_HEADER = 'x-codex-turn-state';

function _headerString(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== wanted) continue;
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item);
      if (first) return first;
    }
  }
  return null;
}

function _headerKeys(headers) {
  if (!headers || typeof headers !== 'object') return [];
  const keys = [];
  for (const key of Object.keys(headers)) {
    const normalized = String(key || '')
      .trim()
      .toLowerCase();
    if (normalized) keys.push(normalized);
  }
  return [...new Set(keys)].sort();
}

function _hasHeaderKey(headers, name) {
  const wanted = String(name || '')
    .trim()
    .toLowerCase();
  if (!wanted) return false;
  return _headerKeys(headers).includes(wanted);
}

const headerCarriers = (event) => [
  event.headers,
  event.response?.headers,
  event.response?.metadata?.headers,
  event.metadata?.headers,
];

export function _captureTurnStateFromEvent(entry, event) {
  if (!entry || entry.turnState || !event || typeof event !== 'object') return;
  // WebSocket turn state is returned by response metadata and replayed only
  // in later response.create metadata for the same logical turn.
  let turnState = null;
  for (const headers of headerCarriers(event)) {
    turnState = _headerString(headers, X_CODEX_TURN_STATE_HEADER);
    if (turnState) break;
  }
  if (turnState) {
    entry.turnState =
      captureCodexTurnState(entry.turnStateScope, entry.turnStateTurnId, turnState, entry) ||
      (!entry.turnStateScope || !entry.turnStateTurnId ? turnState : null);
  }
}

// One redacted trace row per stream for the header key sets the server sends
// on response.created / response.metadata (once with headers, once without).
export function _traceWsHeaderKeys(entry, event, midState, traceProvider, model) {
  try {
    if (!entry || !event || typeof event !== 'object') return;
    const eventType = typeof event.type === 'string' ? event.type : '';
    if (eventType !== 'response.created' && eventType !== 'response.metadata') return;
    const [topLevelHeaderKeys, responseHeaderKeys, responseMetadataHeaderKeys, eventMetadataHeaderKeys] =
      headerCarriers(event).map(_headerKeys);
    const hasAnyHeaders =
      topLevelHeaderKeys.length > 0 ||
      responseHeaderKeys.length > 0 ||
      responseMetadataHeaderKeys.length > 0 ||
      eventMetadataHeaderKeys.length > 0;
    if (hasAnyHeaders && entry.wsHeaderKeysFinalTraced) return;
    if (!hasAnyHeaders && entry.wsHeaderKeysEmptyTraced) return;
    const iteration = Number(midState?.iteration);
    const payload = {
      provider: midState?.traceProvider || traceProvider,
      transport: 'websocket',
      event_type: eventType,
      model: midState?.model || model || null,
      top_level_header_keys: topLevelHeaderKeys,
      response_header_keys: responseHeaderKeys,
      response_metadata_header_keys: responseMetadataHeaderKeys,
      event_metadata_header_keys: eventMetadataHeaderKeys,
      has_turn_state_header: headerCarriers(event).some((headers) => _hasHeaderKey(headers, X_CODEX_TURN_STATE_HEADER)),
      values_redacted: true,
    };
    appendAgentTrace({
      sessionId: midState?.sessionId || null,
      iteration: Number.isFinite(iteration) ? iteration : null,
      kind: 'ws_header_keys',
      provider: payload.provider,
      model: payload.model,
      transport: 'websocket',
      event_type: eventType,
      payload,
    });
    if (hasAnyHeaders) entry.wsHeaderKeysFinalTraced = true;
    else entry.wsHeaderKeysEmptyTraced = true;
  } catch {}
}
