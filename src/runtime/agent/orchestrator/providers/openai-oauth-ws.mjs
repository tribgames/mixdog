/**
 * OpenAI OAuth subscription — WebSocket transport.
 *
 * Single dispatch path for the openai-oauth provider (SSE removed in
 * v0.6.117). Uses the `responses_websockets=2026-02-06` beta WebSocket
 * upgrade on chatgpt.com/backend-api/codex/responses. Per-session
 * connections are pooled (configurable idle TTL, up to 8 parallel sockets per
 * key) so subsequent tool-loop iterations can send only the incremental
 * `input` delta plus `previous_response_id`, skipping the full
 * tools/system/history prefix each turn.
 *
 * Incremental-input reuse is decided by diffing against the cached request
 * the socket last sent (see _sansInput below), and requests carry a
 * turn-state echo header so the backend can correlate WS frames to the
 * in-flight turn.
 *
 * Exposes:
 *   sendViaWebSocket({ auth, body, sendOpts, onStreamDelta, onToolCall,
 *                      onStageChange, externalSignal, poolKey, cacheKey, iteration,
 *                      useModel, traceCtx })
 *
 * The caller (openai-oauth.mjs) supplies a fully built request body and the
 * auth bundle; this module owns the attempt loop: acquire, optional warmup,
 * delta framing, stream, and the hand-off to the per-send helpers
 * (openai-ws-send-attempts / -span / -warmup / -outcome).
 *
 *   openai-ws-send/send-context.mjs     — per-send shared state (budget, warmup, span, resolvers)
 *   openai-ws-send/acquire-attempt.mjs  — per-attempt socket acquire + acquire accounting
 *   openai-ws-send/attempt-request.mjs  — request body, stream state, warmup, wire frame
 *   openai-ws-send/reasoning-replay.mjs — recovery-only reasoning replay policy
 */
import { performance } from 'node:perf_hooks';
import { appendAgentTrace } from '../agent-trace.mjs';
import { acquireWebSocket, _sendFrame, drainOpenaiWsPool } from './openai-ws-pool.mjs';
import { _logicalResponseItemMatch, parseToolSearchArgs, _streamResponse } from './openai-ws-stream.mjs';
import {
  HANDSHAKE_MAX_ATTEMPTS,
  _backoffFor,
  _classifyHandshakeError,
  _defaultSleep,
} from './openai-ws-send-attempts.mjs';
import { startupPrewarmResult, startupWarmupApplies } from './openai-ws-warmup.mjs';
import { completeWsSend } from './openai-ws-send-outcome.mjs';
import { createWsSendContext, notifyStage } from './openai-ws-send/send-context.mjs';
import { acquireForAttempt, newHandshake, recordAcquired } from './openai-ws-send/acquire-attempt.mjs';
import {
  buildWireFrame,
  createAttemptRecord,
  createMidState,
  prepareRequestBody,
  runAttemptWarmup,
} from './openai-ws-send/attempt-request.mjs';

// Legacy import paths for mixdog-session-runtime.mjs (drainOpenaiWsPool),
// the scripts/provider-toolcall/ suites (parseToolSearchArgs,
// _logicalResponseItemMatch, _streamResponse) and other external callers.
export { drainOpenaiWsPool, _logicalResponseItemMatch, parseToolSearchArgs, _streamResponse };
export { _classifyMidstreamError } from './openai-ws-send-attempts.mjs';
export {
  _cacheObservation as _cacheObservationForTest,
  _cacheContinuityResetReason as _cacheContinuityResetReasonForTest,
  _warmupContinuityTrace as _warmupContinuityTraceForTest,
} from './openai-ws-send-outcome.mjs';
export { _applyReasoningReplayPolicy } from './openai-ws-send/reasoning-replay.mjs';

globalThis.__mixdogOpenaiWsRuntimeLoaded = true;

/**
 * Run `_acquire({auth, poolKey, cacheKey})` with bounded exponential-backoff
 * retry on transient handshake failures. The injection seams (`_acquire`,
 * `_sleepFn`, `onRetry`) let unit tests drive the state machine without
 * opening real sockets.
 *
 * On exhaustion the thrown error is tagged with:
 *   err.attempts         — 1..HANDSHAKE_MAX_ATTEMPTS
 *   err.retryClassifier  — final classifier string, or null for permanent
 */
async function _acquireWithRetry({
  auth,
  poolKey,
  cacheKey,
  codexHeaders,
  forceFresh,
  onRetry,
  onBackoffSlept,
  externalSignal,
  _acquire = acquireWebSocket,
  _sleepFn = _defaultSleep,
  maxAttempts = HANDSHAKE_MAX_ATTEMPTS,
  retry429 = true,
} = {}) {
  let lastErr = null;
  let lastClassifier = null;
  const attemptCap =
    Number.isFinite(maxAttempts) && maxAttempts > 0
      ? Math.min(maxAttempts, HANDSHAKE_MAX_ATTEMPTS)
      : HANDSHAKE_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= attemptCap; attempt++) {
    if (externalSignal?.aborted) {
      const reason = externalSignal.reason;
      throw reason instanceof Error ? reason : new Error('OpenAI OAuth WS acquire aborted');
    }
    try {
      if (attempt > 1) {
        if (process.env.MIXDOG_DEBUG_AGENT) {
          process.stderr.write(`[agent-trace] ws-handshake-attempt n=${attempt}\n`);
        }
      }
      return await _acquire({ auth, poolKey, cacheKey, codexHeaders, forceFresh, externalSignal });
    } catch (err) {
      lastErr = err;
      const classifier = _classifyHandshakeError(err, { retry429 });
      lastClassifier = classifier;
      // Permanent (or unknown → default-deny): stop immediately.
      if (!classifier) {
        if (err && typeof err === 'object') {
          try {
            err.attempts = attempt;
          } catch {}
          try {
            err.retryClassifier = null;
          } catch {}
        }
        throw err;
      }
      // Transient but exhausted: surface with tagging.
      if (attempt >= attemptCap) {
        if (err && typeof err === 'object') {
          try {
            err.attempts = attempt;
          } catch {}
          try {
            err.retryClassifier = classifier;
          } catch {}
          try {
            err.wsRetriesExhausted = true;
          } catch {}
        }
        try {
          if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
            process.stderr.write(
              `[openai-oauth-ws] handshake failed after ${attempt}/${attemptCap} attempts: ${err?.message || err}\n`
            );
        } catch {}
        throw err;
      }
      // Schedule backoff and emit progress.
      const backoff = _backoffFor(attempt);
      try {
        onRetry?.({
          attempt,
          max: attemptCap - 1,
          classifier,
          backoffMs: backoff,
          error: err,
        });
      } catch {}
      // Sleep is abort-aware: an abort during backoff rejects immediately
      // instead of burning the remaining wait.
      const sleepStart = performance.now();
      try {
        if (externalSignal) {
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => {
              externalSignal.removeEventListener('abort', onAbort);
              resolve();
            }, backoff);
            const onAbort = () => {
              clearTimeout(t);
              const reason = externalSignal.reason;
              reject(reason instanceof Error ? reason : new Error('OpenAI OAuth WS acquire aborted'));
            };
            if (externalSignal.aborted) {
              onAbort();
              return;
            }
            externalSignal.addEventListener('abort', onAbort, { once: true });
          });
        } else {
          await _sleepFn(backoff);
        }
      } finally {
        try {
          onBackoffSlept?.(performance.now() - sleepStart);
        } catch {}
      }
    }
  }
  // Unreachable — the loop either returns or throws above — but keep the
  // typing honest.
  if (lastErr && typeof lastErr === 'object') {
    try {
      lastErr.attempts = HANDSHAKE_MAX_ATTEMPTS;
    } catch {}
    try {
      lastErr.retryClassifier = lastClassifier;
    } catch {}
  }
  throw lastErr || new Error('acquireWithRetry: unreachable');
}

/**
 * Dispatch one tool-loop iteration over a per-session cached WebSocket.
 * Returns the same shape as the SSE path: { content, model, toolCalls, usage }.
 */
export async function sendViaWebSocket({
  auth,
  body,
  sendOpts,
  onStreamDelta,
  onToolCall,
  onTextDelta,
  onStageChange,
  externalSignal,
  poolKey,
  cacheKey,
  iteration,
  useModel,
  displayModel,
  forceFresh = false,
  includeResponseId = false,
  traceProvider = 'openai-oauth',
  logSuppressedReasoningDeltas = true,
  warmupBody = null,
  // Provider-specific handshake policy seam. OAuth leaves this null and
  // retains the Codex retry budget. Direct OpenAI uses it to surface
  // unsupported-WS handshake statuses immediately so its wrapper can make
  // the single WS→HTTP decision without nested WS retries.
  handshakeErrorPolicy = null,
  // Test seams (undefined in production). Let the unit test drive the
  // retry state machine without opening real sockets or touching the
  // handshake-retry layer.
  _acquireWithRetryFn = _acquireWithRetry,
  _streamFn = _streamResponse,
  _sendFrameFn = _sendFrame,
  _sleepFn = _defaultSleep,
  _sendSpanTraceFn = appendAgentTrace,
  _agentTraceFn = appendAgentTrace,
  _carriedWarmup = null,
  _prewarmedHandle = null,
}) {
  const ctx = createWsSendContext({
    auth,
    body,
    sendOpts,
    onStageChange,
    externalSignal,
    poolKey,
    cacheKey,
    iteration,
    useModel,
    displayModel,
    forceFresh,
    includeResponseId,
    traceProvider,
    logSuppressedReasoningDeltas,
    warmupBody,
    handshakeErrorPolicy,
    _acquireWithRetryFn,
    _streamFn,
    _sendFrameFn,
    _sleepFn,
    _sendSpanTraceFn,
    _agentTraceFn,
    _carriedWarmup,
  });
  const { attempts, sendSpan } = ctx;
  const prewarmed = { handle: _prewarmedHandle };

  for (let attemptIndex = 0; attemptIndex <= attempts.maxMidstreamRetries; attemptIndex++) {
    const handshake = newHandshake();
    sendSpan.acquireAttempts += 1;
    notifyStage(onStageChange, 'requesting');
    let acquired;
    try {
      acquired = await acquireForAttempt(ctx, handshake, { attemptIndex, prewarmed });
    } catch (err) {
      await attempts.handshakeFailed(err, {
        attemptIndex,
        handshakeStart: handshake.start,
        handshakeRetries: handshake.retries,
        handshakeRetryClassifiers: handshake.classifiers,
      });
      continue;
    }
    const { entry, reused } = acquired;
    recordAcquired(ctx, acquired, handshake);
    const requestBody = prepareRequestBody(ctx, entry, attemptIndex);
    const startupWarmupResponseId =
      typeof entry?.startupWarmupResponseId === 'string' ? entry.startupWarmupResponseId : null;
    const midState = createMidState(ctx, attemptIndex);
    const attempt = createAttemptRecord({ attemptIndex, reused, handshake, startupWarmupResponseId });
    let result;
    try {
      if (startupWarmupApplies({ warmupBody, completedWarmup: ctx.warmup.completed, attemptIndex, entry })) {
        await runAttemptWarmup(ctx, { entry, attemptIndex, midState, attempt });
      }

      // Codex performs generate:false during session startup, then hands
      // this live client session to the first real turn. Startup callers
      // stop here.
      if (sendOpts?._startupPrewarmOnly === true) {
        const out = startupPrewarmResult({
          entry,
          poolKey,
          cacheKey,
          warmupResult: attempt.warmupResult,
          startupWarmupResponseId,
          useModel,
        });
        out.transportTiming = sendSpan.emit('ok');
        return out;
      }

      const requestBuildStart = performance.now();
      const wireFrame = buildWireFrame(ctx, attempt, entry, requestBody);
      // Re-check abort after acquire/warmup — narrow window where
      // externalSignal could fire between successful acquire and
      // send(). Without this gate an aborted request could still
      // emit one frame to the provider.
      if (externalSignal?.aborted) {
        // Preserve the abort reason (Error) so downstream
        // classification (userAbort vs. generic) survives — a bare
        // new Error('Aborted') would erase that signal.
        const reason = externalSignal.reason;
        throw reason instanceof Error ? reason : new Error('Aborted');
      }
      sendSpan.requestBuildSerializationMs += performance.now() - requestBuildStart;
      await _sendFrameFn(entry, wireFrame, sendSpan);
      midState.sendSpan = sendSpan;
      midState.sendStartedAt = performance.now();

      if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(
          `[agent-trace] ws-streaming-start sinceAcquire=${Math.round(performance.now() - handshake.start)}ms\n`
        );
      }
      notifyStage(onStageChange, 'streaming');
      result = await _streamFn({
        entry,
        externalSignal,
        onStreamDelta,
        onToolCall,
        onTextDelta,
        state: midState,
        logSuppressedReasoningDeltas,
        traceProvider,
        _timeouts: null,
        knownToolNames: ctx.knownToolNames,
      });
    } catch (err) {
      await attempts.streamFailed(err, { attemptIndex, entry, midState });
      continue;
    }
    const out = completeWsSend({
      send: ctx.send,
      attempt,
      entry,
      result,
      requestBody,
      completedWarmup: ctx.warmup.completed,
    });
    out.transportTiming = sendSpan.emit('ok');
    return out;
  }
  // Unreachable — the loop either returns or throws above.
  throw attempts.exhausted();
}
