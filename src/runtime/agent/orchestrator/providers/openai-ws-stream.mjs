/**
 * openai-ws-stream.mjs — WS Responses stream consumer + incremental-input
 * delta engine for the OpenAI OAuth WebSocket transport.
 *
 * Owns:
 *   - request/response item matching + delta computation (_computeDelta,
 *     _sansInput, _logicalResponseItemMatch, ...) used to send only the
 *     input tail on a warm socket (re-exported from openai-ws-delta.mjs),
 *   - the per-response stream loop (_streamResponse): setup, the settle, and
 *     the wiring of the phases under openai-ws-stream/ (socket handlers, the
 *     event switch, terminal frames, outcome stamping). The data events fold
 *     into lives in openai-ws-response-state.mjs, the timers in
 *     openai-ws-watchdogs.mjs, visible text / leaked-tool recovery in
 *     openai-ws-text-relay.mjs and the terminal error shapes in
 *     openai-ws-terminal.mjs.
 *
 * sendViaWebSocket (openai-oauth-ws.mjs) is the only production caller;
 * scripts import parseToolSearchArgs/_logicalResponseItemMatch via the
 * openai-oauth-ws.mjs re-exports.
 */
import {
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS,
  PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
  PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS,
  PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS,
} from '../stall-policy.mjs';
import { _wsErrLabel, WS_MAX_INCOMING_FRAME_BYTES } from './openai-ws-pool.mjs';
import { createWsResponseState } from './openai-ws-response-state.mjs';
import { createWsTextRelay } from './openai-ws-text-relay.mjs';
import { createWsStreamWatchdogs } from './openai-ws-watchdogs.mjs';
import {
  enableSessionTransportTracking,
  disableSessionTransportTracking,
  markSessionTransportActivity,
} from '../session/manager/runtime-liveness.mjs';
import { createTerminalFrameHandlers } from './openai-ws-stream/terminal-frames.mjs';
import { createWsEventSwitch } from './openai-ws-stream/event-switch.mjs';
import { createSocketHandlers } from './openai-ws-stream/socket-handlers.mjs';
import { stampTerminalOutcome } from './openai-ws-stream/outcome.mjs';

// Facade re-exports so existing importers of openai-ws-stream.mjs
// (openai-oauth-ws.mjs et al) keep resolving these symbols unchanged.
export { _logicalResponseItemMatch, _computeDelta, _estimateFrameTokens } from './openai-ws-delta.mjs';
export { _combineUsageWithWarmup } from './openai-ws-events.mjs';
export { parseToolSearchArgs } from './openai-ws-response-state.mjs';
export { _captureTurnStateFromEvent } from './openai-ws-stream/turn-state-headers.mjs';

// Positive-int coercion for per-call timeout overrides: finite > 0 → floor,
// else fallback.
function _positiveInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
// Pre-`response.created` deadline. Once the socket is open and the
// response.create frame is sent, a healthy server emits response.created
// within seconds. If it stalls past this short bound the socket has wedged
// post-upgrade with zero server events — treat it as a fast, retryable
// first-byte timeout. This is the ONLY pre-stream watchdog; once any server
// event arrives the single inter-chunk idle timer below takes over. Only this
// short window is shortened; the post-`response.created` inter-chunk /
// reasoning span keeps the longer deadlines.
export const WS_PRE_RESPONSE_CREATED_MS = (() => {
  const raw = process.env.MIXDOG_PROVIDER_WS_PRE_RESPONSE_CREATED_TIMEOUT_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.max(n, 1_000), PROVIDER_FIRST_BYTE_TIMEOUT_MS);
  return PROVIDER_FIRST_BYTE_TIMEOUT_MS;
})();
// Single inter-chunk idle timer. Resets on EVERY received frame — any frame,
// including metadata/keepalive, proves the socket is live.
export const WS_INTER_CHUNK_MS = PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS;

function resolveStreamTimeouts(_timeouts) {
  // First-MEANINGFUL-frame deadline. Distinct from preResponseCreatedMs (a
  // short pre-created byte-silence window that resetIdle clears on the FIRST
  // frame of any kind): this timer is cleared only by a meaningful response
  // event (response.created or the first content/tool-arg delta), so a server
  // that ACKs with keepalive/metadata-only frames — resetting inter-chunk idle
  // forever — still trips a stall before the agent watchdog's first-byte abort.
  // WS owns its semantic-idle window. The TUI backstop is deliberately much
  // longer, so this timeout can fail/retry/fallback at the provider boundary
  // without racing an outer turn abort.
  const semanticIdleMs = PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS;
  return {
    preResponseCreatedMs: _positiveInt(_timeouts?.preResponseCreatedMs, WS_PRE_RESPONSE_CREATED_MS),
    interChunkMs: _positiveInt(_timeouts?.interChunkMs, WS_INTER_CHUNK_MS),
    maxIncomingFrameBytes: _positiveInt(_timeouts?.maxIncomingFrameBytes, WS_MAX_INCOMING_FRAME_BYTES),
    firstMeaningfulMs: _positiveInt(_timeouts?.firstMeaningfulMs, PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS),
    semanticIdleMs,
    semanticIdleEnabled: PROVIDER_SSE_IDLE_WATCHDOG_ENABLED && semanticIdleMs > 0,
  };
}

export async function _streamResponse({
  entry,
  externalSignal,
  onStreamDelta,
  onToolCall,
  onTextDelta,
  state,
  logSuppressedReasoningDeltas = true,
  traceProvider = 'openai-oauth',
  _timeouts = null,
  knownToolNames = null,
}) {
  const errLabel = _wsErrLabel(traceProvider);
  const socket = entry.socket;
  enableSessionTransportTracking(state?.sessionId);
  // An already-open (possibly pooled) socket proves transport availability;
  // response.created/reasoning/text/tool events independently satisfy the
  // semantic deadline.
  if (socket?.readyState === WebSocket.OPEN) {
    markSessionTransportActivity(state?.sessionId);
  }
  const { maxIncomingFrameBytes, ...timeouts } = resolveStreamTimeouts(_timeouts);
  const streamingStart = Date.now();
  // Mid-stream retry classifier needs to distinguish "stream died before we
  // even saw response.created" from "stream died after we had a partial
  // response but before completion". Mutate the shared state object so the
  // caller can inspect flags on the error path.
  const midState = state || {};
  midState.sawResponseCreated = midState.sawResponseCreated || false;
  midState.sawCompleted = midState.sawCompleted || false;
  midState.wsCloseCode = null;
  midState.responseFailedPayload = null;
  const response = createWsResponseState({ onToolCall, onStreamDelta, midState, traceProvider });
  const textRelay = createWsTextRelay({ response, knownToolNames, sessionState: state, onTextDelta, onStreamDelta });
  const progress = (kind) => {
    try {
      onStreamDelta?.(kind);
    } catch {}
  };
  let reasoningDeltaLogEmitted = false;
  const logReasoningDeltaSuppression = () => {
    if (!logSuppressedReasoningDeltas) return;
    const seen = response.reasoningDeltaSummary();
    if (reasoningDeltaLogEmitted || !seen) return;
    reasoningDeltaLogEmitted = true;
    process.stderr.write(
      `[openai-oauth-ws] suppressed reasoning text deltas from user content count=${seen.total} text=${seen.text} summary=${seen.summary} other=${seen.other}\n`
    );
  };
  // The one settle record every handler writes: `terminalError` decides
  // reject/resolve, `done` gates late close/error/abort events.
  const outcome = { terminalError: null, done: false };

  return new Promise((resolve, reject) => {
    // Streamed partial state for a stream that ended WITHOUT the terminal
    // response.completed/done frame. The transport never synthesizes a
    // completion: it reports the continuation plus what it had, and the loop
    // decides (partial text failure / explicit tool-call turn).
    const attachPartialState = (err) => {
      if (!err) return err;
      // Fold the held leak-guard tail into `content` FIRST so the partial
      // snapshot keeps legitimate trailing text; finish() then skips the
      // flush (terminalError set) without losing it.
      try {
        textRelay.flush();
      } catch {
        /* best-effort */
      }
      try {
        Object.assign(err, response.partialState());
      } catch {
        /* best-effort enrichment */
      }
      return err;
    };
    /** Every watchdog expiry: the error is the outcome, the close is
     *  best-effort, and the settle never waits on the socket (socket.close()
     *  may not settle a half-open WS, so the close handler may never fire). */
    const fail = (err, closeReason) => {
      outcome.terminalError = err;
      try {
        socket.close(4000, closeReason);
      } catch {}
      finish();
    };
    const watchdogs = createWsStreamWatchdogs({
      midState,
      traceProvider,
      streamingStart,
      currentModel: () => response.model,
      timeouts,
      attachPartialState,
      fail,
    });
    let handlers = null;
    const finish = () => {
      logReasoningDeltaSuppression();
      // On a terminal error we must NOT flush buffered text/tool calls:
      // finish() rejects below, so flushing would emit partial output the
      // caller then never consumes as a clean result (double-render/
      // double-dispatch risk). The partial-final path reads partialContent
      // off the error instead. Only flush the held-back tail on success.
      if (!outcome.terminalError) textRelay.flush();
      disableSessionTransportTracking(midState.sessionId);
      watchdogs.clearAll();
      handlers?.detach();
      if (outcome.terminalError) {
        stampTerminalOutcome(outcome.terminalError, midState, response);
        reject(outcome.terminalError);
        return;
      }
      resolve(response.result());
    };
    const terminal = createTerminalFrameHandlers({
      response,
      textRelay,
      midState,
      errLabel,
      progress,
      outcome,
      finish,
    });
    const onEvent = createWsEventSwitch({
      response,
      textRelay,
      watchdogs,
      midState,
      progress,
      terminal,
      streamingStart,
    });
    handlers = createSocketHandlers({
      socket,
      entry,
      externalSignal,
      midState,
      response,
      errLabel,
      maxIncomingFrameBytes,
      watchdogs,
      traceProvider,
      onEvent,
      outcome,
      finish,
    });
    if (!handlers.attach()) return;
    watchdogs.armPreStream();
    watchdogs.armFirstMeaningful();
    // No proactive client ping: Codex's Responses WebSocket uses the library
    // default (automatic pong replies, no periodic client ping). Incoming
    // frames remain bounded by the 300s stream idle timeout.
  });
}
