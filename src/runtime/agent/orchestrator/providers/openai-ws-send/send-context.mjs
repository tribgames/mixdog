/**
 * send-context.mjs — everything one logical WS send shares across its
 * attempts: the recovery budget, the retained warmup, the Codex handshake
 * metadata, the send span and the attempt-failure resolvers.
 */
import { createStreamSafetyStamps, resolveStallRetryBudget } from '../retry-classifier.mjs';
import { _codexWsCompatibilityHeaders } from '../openai-codex-metadata.mjs';
import { createWsSendAttempts } from '../openai-ws-send-attempts.mjs';
import { createWsSendSpan } from '../openai-ws-send-span.mjs';

/** Stage callbacks are observers; a throwing one never fails the send. */
export function notifyStage(onStageChange, stage, detail) {
  try {
    if (detail === undefined) onStageChange?.(stage);
    else onStageChange?.(stage, detail);
  } catch {}
}

export function createWsSendContext(opts) {
  const {
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
    includeResponseId,
    traceProvider,
    handshakeErrorPolicy,
    _sleepFn,
    _sendSpanTraceFn,
    _agentTraceFn,
    _carriedWarmup,
  } = opts;
  // Shared logical-send window: WS retries and loop replay consume the same
  // recovery budget.
  const stallRetryBudget = resolveStallRetryBudget(sendOpts);
  // A generate:false prewarm is billable even if its main request later
  // retries on a fresh socket or falls back to HTTP. Retain one completed
  // result across the whole logical send and attach it to terminal errors.
  const warmup = { completed: _carriedWarmup?.usage ? _carriedWarmup : null };
  const stampWarmup = (err) => {
    if (!err || !warmup.completed?.usage) return err;
    try {
      Object.defineProperty(err, '__warmup', {
        value: warmup.completed,
        configurable: true,
        enumerable: false,
      });
    } catch {}
    return err;
  };
  // Known tool names for the leaked-tool-call guard in _streamResponse.
  // Derived from the exact request body so a recovered leaked call only
  // synthesizes when it names a tool actually offered to this request.
  const knownToolNames = new Set(
    (Array.isArray(body?.tools) ? body.tools : [])
      .map((t) => (typeof t?.name === 'string' ? t.name : null))
      .filter(Boolean)
  );
  // Live-text invariant across attempts: once ANY attempt has relayed a
  // non-empty text chunk to the client, no error thrown out of the send may
  // omit the liveTextEmitted/unsafeToRetry markers — otherwise an upstream
  // gate (auth-refresh retry, HTTP fallback, shared withRetry) could reissue
  // the turn and concatenate a second attempt onto already-rendered output.
  // A text-emitting attempt is never retry-eligible (_classifyMidstreamError
  // returns null on emittedText), so the surfaced error is frequently an
  // EARLIER attempt's firstAttemptError that never saw the marker; the stamps
  // re-apply it on every throw path (see createStreamSafetyStamps).
  const safetyStamps = createStreamSafetyStamps();
  const useCodexWsClientMetadata = traceProvider === 'openai-oauth';
  // model + serviceTier feed the handshake routing hint. service_tier is on
  // the body only when fast selected the priority tier, so the hint carries
  // `model=` alone otherwise — the same shape the reference client sends.
  const codexMetadataContext = {
    poolKey,
    cacheKey,
    sendOpts,
    model: useModel,
    serviceTier: body?.service_tier || '',
  };
  const codexHandshakeHeaders = useCodexWsClientMetadata
    ? _codexWsCompatibilityHeaders({ ...codexMetadataContext, handshake: true })
    : null;
  const sendSpan = createWsSendSpan({
    sendOpts,
    traceProvider,
    useModel,
    poolKey,
    iteration,
    traceFn: _sendSpanTraceFn,
  });
  // Single caller-visible recovery path for both handshake/acquire retries
  // and retryable stream failures. The session/TUI stage bridge renders this
  // as non-terminal reconnect progress; transport code must not also print it
  // to stderr.
  const emitReconnectProgress = ({ attempt, max, classifier }) => {
    const retryAttempt = Number(attempt) || 1;
    const retryMax = Number(max) || 1;
    notifyStage(onStageChange, 'reconnecting', {
      attempt: retryAttempt,
      max: retryMax,
      classifier: classifier || null,
      message: `Reconnecting... ${retryAttempt}/${retryMax}`,
    });
  };
  // Only Codex OAuth follows retry_429:false. This shared transport also
  // backs xAI, whose existing 429 handshake retry behavior must remain.
  const retry429 = traceProvider !== 'openai-oauth';
  const attempts = createWsSendAttempts({
    externalSignal,
    sleepFn: _sleepFn,
    sendSpan,
    emitReconnectProgress,
    stampWarmup,
    safetyStamps,
    handshakeErrorPolicy,
    retry429,
    stallRetryBudget,
    trace: { poolKey, traceProvider, useModel },
    auth,
    body,
  });
  const send = {
    poolKey,
    cacheKey,
    iteration,
    traceProvider,
    useModel,
    displayModel,
    sendOpts,
    useCodexWsClientMetadata,
    includeResponseId,
    agentTraceFn: _agentTraceFn,
    body,
  };
  return {
    opts,
    warmup,
    knownToolNames,
    useCodexWsClientMetadata,
    codexMetadataContext,
    codexHandshakeHeaders,
    sendSpan,
    emitReconnectProgress,
    retry429,
    attempts,
    send,
  };
}
