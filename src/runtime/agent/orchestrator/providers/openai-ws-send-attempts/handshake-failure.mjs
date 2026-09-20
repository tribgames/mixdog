/**
 * handshake-failure.mjs — decide what a failed acquire/handshake means for
 * the send: retry on a fresh socket (true) or throw the error to surface.
 */
import { performance } from 'node:perf_hooks';
import { traceAgentFetch } from '../../agent-trace.mjs';
import { _classifyHandshakeError, _mustSurfaceCurrentAttempt, tag } from './policy.mjs';

function handshakeClassifier(err, retry429) {
  return (
    err?.retryClassifier ||
    _classifyHandshakeError(err, { retry429 }) ||
    (err?.code === 'EWSACQUIRETIMEOUT' ? 'acquire_timeout' : null)
  );
}

function traceHandshake(ctx, err, { handshakeStart, handshakeRetries, classifiers }) {
  const { trace } = ctx.deps;
  traceAgentFetch({
    sessionId: trace.poolKey,
    headersMs: performance.now() - handshakeStart,
    httpStatus: Number(err?.httpStatus || 0),
    provider: trace.traceProvider,
    model: trace.useModel,
    transport: 'websocket',
    handshakeRetries: err?.attempts ? Math.max(Number(err.attempts) - 1, 0) : handshakeRetries,
    handshakeRetryClassifiers: classifiers,
  });
}

/** Provider-supplied veto: `{ retry: false }` surfaces the error as-is. */
function policyVetoes(ctx, err, classifier, attemptIndex) {
  const { handshakeErrorPolicy } = ctx.deps;
  if (typeof handshakeErrorPolicy !== 'function') return false;
  const decision = handshakeErrorPolicy({
    error: err,
    status: Number(err?.httpStatus || 0),
    classifier,
    attempt: attemptIndex + 1,
    maxAttempts: ctx.maxMidstreamRetries + 1,
  });
  if (decision?.retry !== false) return false;
  tag(err, {
    wsFailurePhase: 'handshake',
    wsHttpFallbackEligible: decision.httpFallback === true,
    ...(classifier ? { retryClassifier: classifier } : {}),
  });
  return true;
}

/**
 * @returns {Promise<true>} the caller starts the next attempt
 * @throws the error the caller must surface
 */
export async function resolveHandshakeFailure(
  ctx,
  err,
  { attemptIndex, handshakeStart, handshakeRetries, handshakeRetryClassifiers }
) {
  const { deps, state } = ctx;
  const { sendSpan, externalSignal, retry429 } = deps;
  deps.stampWarmup(err);
  sendSpan.poolAcquireMs += performance.now() - handshakeStart;
  sendSpan.poolOwnerWaitMs += Math.max(0, Number(err?.ownerWaitMs) || 0);
  // Provenance only; policy remains provider-owned below. This lets the
  // direct wrapper distinguish an upgrade rejection from an application
  // error carrying the same HTTP status.
  tag(err, { wsFailurePhase: 'handshake' });
  const classifier = handshakeClassifier(err, retry429);
  const classifiers = [...handshakeRetryClassifiers];
  if (classifier && !classifiers.includes(classifier)) classifiers.push(classifier);
  if (err?.httpStatus != null || classifier || handshakeRetries > 0 || classifiers.length > 0) {
    traceHandshake(ctx, err, { handshakeStart, handshakeRetries, classifiers });
  }
  if (policyVetoes(ctx, err, classifier, attemptIndex)) throw ctx.surface(err);
  // HTTP 401 is reserved for caller-owned auth refresh. HTTP 426 is
  // caller-owned immediate HTTPS fallback. Every other recognized
  // transport failure spends the shared stream retry budget.
  const status = Number(err?.httpStatus || 0);
  const retryable =
    classifier && status !== 401 && status !== 426 && err?.unsafeToRetry !== true && !externalSignal?.aborted;
  if (retryable && attemptIndex < ctx.maxMidstreamRetries) {
    ctx.scheduleRetry(err, {
      attemptIndex,
      classifier,
      retryLimit: ctx.maxMidstreamRetries,
      remember: !state.firstAttemptError,
    });
    await ctx.backoff(attemptIndex + 1);
    return true;
  }
  // A later auth/upgrade decision must win over an earlier transient
  // failure so the caller can refresh or switch transport. Likewise,
  // never replace a current cancellation with stale retry history.
  if (_mustSurfaceCurrentAttempt(err, externalSignal)) {
    if (retryable && attemptIndex >= ctx.maxMidstreamRetries) {
      tag(err, { midstreamRetries: attemptIndex, midstreamClassifier: classifier, wsRetriesExhausted: true });
    }
    throw ctx.surface(err, err);
  }
  if (attemptIndex > 0 && state.firstAttemptError) {
    throw ctx.surface(ctx.surfaceFirstAttempt(attemptIndex, ctx.maxMidstreamRetries));
  }
  throw ctx.surface(err);
}
