/**
 * anthropic-sse.mjs — Anthropic SSE stream parser + mid-stream retry policy.
 *
 * Shared by both Anthropic providers. anthropic-oauth.mjs retains its public
 * re-exports for provider test and integration entry points.
 */
import {
  classifyMidstreamError,
  MIDSTREAM_RETRY_POLICY,
  sleepWithAbort,
  typedStatusFrom,
} from './retry-classifier.mjs';
import { frameProviderSseChunk, releaseProviderSseStream, retainProviderSseStream } from './stream-json-pool.mjs';
import { splitSseRegion } from './lib/sse-framing.mjs';
import { stampStreamOutcome, STREAM_TRANSPORTS, STREAM_OUTCOME_VERSION } from './lib/stream-outcome.mjs';
import { createAnthropicSseTurn } from './anthropic-sse-turn.mjs';
import { createAnthropicSseWatchdogs } from './anthropic-sse-watchdogs.mjs';

/** Bounded mid-stream SSE retries (transient stream loss); shared with anthropic.mjs.
 *  Sourced from the single shared retry-budget table (MIDSTREAM_RETRY_POLICY.sse). */
export const ANTHROPIC_MAX_MIDSTREAM_RETRIES = MIDSTREAM_RETRY_POLICY.sse.defaultRetries;

// Policy passed to the shared classifyMidstreamError for the SSE path. The
// top-of-function attempt-budget gate uses defaultRetries (3); perClassifierGate
// is false so the classifier returns raw bucket strings (the loop owns the
// MAX_MIDSTREAM_RETRIES bound), matching the former _classifyMidstreamError.
const SSE_MIDSTREAM_POLICY = {
  mode: 'sse',
  defaultRetries: MIDSTREAM_RETRY_POLICY.sse.defaultRetries,
  perClassifierGate: false,
};

// --- SSE parser ---

// Per-stream identity for the shared framing pool: every chunk of one stream
// settles in submission order (and prefers one worker) regardless of whether
// it was framed inline or offloaded.
let _sseStreamSequence = 0;

function _captureMidstreamAbort(state, reason) {
  if (!state) return;
  const reasonName = reason?.name || '';
  if (reasonName === 'AgentStallAbortError' || reasonName === 'StreamStalledAbortError') {
    state.watchdogAbort = reasonName;
  } else if (reasonName !== 'ProviderTimeoutError' && reasonName !== 'StreamStalledError') {
    // Internal timeout/stall abort reasons are transport symptoms, not a
    // caller decision. Recording them as userAbort silently vetoed the
    // mid-stream retry ladder (_classifyMidstreamSse returns null on
    // userAbort → the turn surfaced as an instant unlogged failure).
    // Leaving state untouched keeps them classifiable by the thrown error
    // itself (EPROVIDERTIMEOUT/ESTREAMSTALL → transient/stall retry).
    state.userAbort = true;
  }
}

// Abort-aware mid-stream backoff sleep → shared sleepWithAbort
// (retry-classifier.mjs). abortMessage preserves the prior fallback text.
export function _midstreamSleepWithAbort(ms, signal, sleepFn) {
  return sleepWithAbort(ms, signal, sleepFn, 'Anthropic OAuth mid-stream retry backoff aborted');
}

// Anthropic's documented error-event `type` enumeration → HTTP equivalent.
// This is STRUCTURED evidence (an explicit wire field with a closed value set),
// never a message-text guess: an event whose only hint is prose keeps no status
// at all, so the retry/auth layers see it as unknown and terminate the turn.
const ANTHROPIC_SSE_ERROR_TYPE_STATUS = new Map([
  ['invalid_request_error', 400],
  ['authentication_error', 401],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['request_too_large', 413],
  ['rate_limit_error', 429],
  ['api_error', 500],
  ['overloaded_error', 503],
]);

function _statusForAnthropicSseError(event, payload) {
  // 1) A real numeric status carried by the event/error payload.
  const numeric = typedStatusFrom(payload, event);
  if (numeric) return numeric;
  // 2) The explicit structured error type/code (exact enumeration match).
  for (const field of [payload?.type, payload?.code, event?.error?.type, event?.error?.code]) {
    const key = typeof field === 'string' ? field.trim().toLowerCase() : '';
    if (key && ANTHROPIC_SSE_ERROR_TYPE_STATUS.has(key)) {
      return ANTHROPIC_SSE_ERROR_TYPE_STATUS.get(key);
    }
  }
  return 0;
}

function _anthropicSseError(event) {
  const payload = event?.error && typeof event.error === 'object' ? event.error : event;
  const type = payload?.type || event?.type || 'error';
  const message = payload?.message || 'Anthropic SSE error';
  const err = new Error(`Anthropic OAuth SSE error ${type}: ${message}`);
  err.name = 'AnthropicSseError';
  err.code = 'EANTHROPIC_SSE_ERROR';
  err.providerErrorType = type;
  err.requestId = event?.request_id || event?.requestId || null;
  const status = _statusForAnthropicSseError(event, payload);
  if (status) {
    err.httpStatus = status;
    err.status = status;
  }
  // Wire-error marker: an error type OUTSIDE the documented enumeration
  // (no status resolved above) default-retries under the shared wire-error
  // contract instead of failing the turn as 'unknown'. Typed statuses and
  // the fatal-code deny-list still take precedence in classifyError().
  err.providerWireError = true;
  if (typeof type === 'string' && type && type !== 'error') err.providerErrorCode = type;
  return err;
}

// Fold one framed SSE record into the turn. Returns true when the stream loop
// must stop reading (a terminal frame). A malformed record is skipped exactly
// like the former per-event JSON.parse throw — and, unlike a whole-batch
// rejection, the well-formed records beside it still run.
function applyAnthropicSseEvent(framedEvent, { turn, watchdogs, state, progress }) {
  const event = framedEvent.value;
  try {
    if (framedEvent.name === 'error' || event?.type === 'error' || event?.error) {
      throw _anthropicSseError(event);
    }
    switch (event.type) {
      case 'message_start':
        if (!event.message) return false;
        watchdogs.clearFirstMessageTimer();
        if (state) state.sawMessageStart = true;
        // The transport idle is first armed here, so it only ever guards
        // MID-stream silence; the first-byte window owns everything before.
        watchdogs.resetIdleTimer();
        // Transport activity was already reported for the raw chunk; this
        // reports the semantic message boundary.
        progress('semantic');
        turn.onMessageStart(event.message);
        return false;
      case 'content_block_start':
        turn.onContentBlockStart(event.index, event.content_block);
        return false;
      case 'content_block_delta':
        turn.onContentBlockDelta(event.index, event.delta);
        return false;
      case 'content_block_stop':
        turn.onContentBlockStop(event.index);
        return false;
      case 'message_delta':
        return turn.onMessageDelta(event);
      case 'message_stop':
        turn.onMessageStop();
        // Anthropic streams can keep emitting `:ping` keepalive frames after
        // `message_stop`; waiting for EOF would hang the reader loop
        // indefinitely, so reading stops the moment the message ends.
        return true;
      default:
        return false;
    }
  } catch (err) {
    if (err?.code === 'EANTHROPIC_SSE_ERROR') throw err;
    /* skip malformed events */
    return false;
  }
}

export async function parseSSEStream(
  response,
  signal,
  abortStream,
  onStreamDelta,
  onToolCall,
  state,
  onTextDelta,
  knownToolNames,
  { relayProgressUpdates = false } = {}
) {
  // Anthropic/Claude parity: every received SSE byte proves transport
  // activity, including comment and named ping keepalives. Content kinds
  // remain distinct on onStreamDelta so TTFT and visible-progress accounting
  // do not mistake transport heartbeats for model output.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const streamKey = `anthropic-sse#${++_sseStreamSequence}`;
  const progress = (kind) => {
    try {
      onStreamDelta?.(kind);
    } catch {}
  };
  const turn = createAnthropicSseTurn({
    state,
    onStreamDelta,
    onToolCall,
    onTextDelta,
    knownToolNames,
    relayProgressUpdates,
  });
  const watchdogs = createAnthropicSseWatchdogs({
    state,
    reader,
    signal,
    abortStream,
    attachStallPartial: turn.attachStallPartial,
  });
  const abortedError = () => {
    _captureMidstreamAbort(state, signal.reason);
    return signal.reason instanceof Error ? signal.reason : new Error('Anthropic OAuth SSE stream aborted');
  };
  const onAbort = () => {
    try {
      const _c = reader.cancel('SSE aborted');
      if (_c && typeof _c.catch === 'function') _c.catch(() => {});
    } catch {}
  };
  let buffer = '';
  let currentEvent = '';
  retainProviderSseStream(streamKey);
  try {
    // Reader ownership begins at getReader() above, so even a signal that
    // was already aborted must pass through this try/finally cleanup path.
    if (signal) {
      if (signal.aborted) throw abortedError();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    watchdogs.armFirstMessageTimer();
    streamLoop: while (true) {
      let chunk;
      try {
        chunk = await watchdogs.read();
      } catch (err) {
        throw watchdogs.readFailure() ?? (signal?.aborted ? abortedError() : err);
      }
      const { done, value } = chunk;
      if (done) break;
      if (state?.sawMessageStart) watchdogs.resetIdleTimer();
      progress('transport');
      buffer += decoder.decode(value, { stream: true });
      // ONE unit of work per network chunk: the pool frames + parses the
      // whole chunk (in a worker once it is worth the round-trip, otherwise
      // inline and synchronously). `region` holds only complete records and
      // the trailing partial line stays in `buffer`.
      const { region, rest } = splitSseRegion(buffer);
      buffer = rest;
      if (!region) continue;
      // A completed reader.read() owns these frames even if abort races
      // immediately afterward, so framing is deliberately NOT signal
      // canceled: the next read observes the cancellation after the
      // frames of this chunk are relayed.
      const framed = frameProviderSseChunk(region, { currentEvent, streamKey });
      const framedChunk = typeof framed?.then === 'function' ? await framed : framed;
      currentEvent = framedChunk.currentEvent;
      for (const framedEvent of framedChunk.events) {
        if (framedEvent.error) continue;
        if (applyAnthropicSseEvent(framedEvent, { turn, watchdogs, state, progress })) break streamLoop;
      }
    }
    turn.flushLeak();
    if (state?.sawMessageStart && !state?.sawCompleted) throw turn.truncatedError();
    return turn.result();
  } finally {
    watchdogs.dispose();
    try {
      releaseProviderSseStream(streamKey);
    } catch {}
    if (signal) signal.removeEventListener('abort', onAbort);
    // message_stop deliberately exits before EOF because Anthropic may keep
    // sending pings. Cancel the reader so the successful response body and
    // underlying keep-alive connection are not stranded.
    try {
      await reader.cancel('Anthropic SSE complete');
    } catch {}
    try {
      reader.releaseLock();
    } catch (err) {
      try {
        process.stderr.write(`[anthropic-oauth] reader releaseLock failed: ${err?.message ?? String(err)}\n`);
      } catch {}
    }
  }
}

/**
 * Classify an Anthropic SSE failure for single-shot mid-stream retry.
 *
 * Retry is allowed only after `message_start` and before `message_stop`,
 * and only when no tool call has already been surfaced to the loop.
 * That keeps recovery limited to transport/stream stalls without risking
 * duplicate eager tool execution.
 */
// Thin wrapper: the SSE mid-stream decision tree now lives in the shared
// classifyMidstreamError (retry-classifier.mjs, policy.mode='sse'). Kept as a
// named export so internal call sites AND anthropic.mjs (which imports this
// symbol) keep resolving it. Behavior is byte-identical — the shared function
// is the relocated original, gated by SSE_MIDSTREAM_POLICY (defaultRetries=3,
// perClassifierGate:false).
export function _classifyMidstreamError(err, state) {
  return classifyMidstreamError(err, state, SSE_MIDSTREAM_POLICY);
}

/**
 * Wrapper-level canonical stamp for the Anthropic providers (API key + OAuth).
 *
 * The PARSER is the authority on what the stream produced: it knows the
 * difference between "a tool_use block started" (coarse
 * `midState.partialToolCall`, set on the first input_json_delta) and "a tool
 * input never completed and was never dispatched" (`pendingToolInput`, which
 * stays replay-safe). Merging the coarse mid-state flag over a stamped parser
 * verdict would downgrade an idempotent truncation into a non-replayable one.
 *
 * So: when the error already carries an authoritative parser record, only
 * genuinely NEW exposure evidence observed by the wrapper is merged (relayed
 * text, exposed thinking, dispatched tool call). Otherwise (transport/SDK
 * errors that never reached the parser) the full mid-state is stamped.
 */
export function stampAnthropicStreamOutcome(err, midState, { provider = 'anthropic' } = {}) {
  const hasParserVerdict = err?.streamOutcome?.version === STREAM_OUTCOME_VERSION;
  if (hasParserVerdict) {
    return stampStreamOutcome(err, {
      transport: STREAM_TRANSPORTS.SSE,
      provider,
      textEmitted: midState?.emittedText === true,
      reasoningEmitted: midState?.emittedThinking === true,
      toolCallsDispatched: midState?.emittedToolCall === true ? 1 : 0,
    });
  }
  return stampStreamOutcome(err, midState || {}, {
    transport: STREAM_TRANSPORTS.SSE,
    provider,
    continuation: midState?.sawCompleted !== true,
  });
}
