/**
 * acquire-attempt.mjs — obtain the socket for one attempt (reserved prewarm
 * handle or a fresh/pooled acquire) and record what the acquire cost.
 */
import { performance } from 'node:perf_hooks';
import { traceAgentFetch } from '../../agent-trace.mjs';

/** Per-attempt handshake facts; survives the acquire throwing. */
export function newHandshake() {
  return { start: performance.now(), retries: 0, classifiers: [] };
}

export async function acquireForAttempt(ctx, handshake, { attemptIndex, prewarmed }) {
  const { auth, poolKey, cacheKey, forceFresh, externalSignal, _acquireWithRetryFn } = ctx.opts;
  const { attempts, sendSpan, emitReconnectProgress, retry429, codexHandshakeHeaders } = ctx;
  const handle = prewarmed.handle;
  const reserved =
    attemptIndex === 0 &&
    forceFresh !== true &&
    handle?.entry &&
    handle.poolKey === poolKey &&
    handle.cacheKey === cacheKey;
  if (reserved) {
    prewarmed.handle = null;
    return { entry: handle.entry, reused: true, prewarmed: true };
  }
  return await _acquireWithRetryFn({
    auth,
    poolKey,
    cacheKey,
    codexHeaders: codexHandshakeHeaders,
    // Retry attempt must not reuse a pooled socket — the prior
    // one is either torn down or in an unknown state.
    forceFresh: forceFresh || attemptIndex > 0,
    externalSignal,
    // No nested connect retry budget: the outer stream loop owns
    // all retries for this logical request.
    maxAttempts: 1,
    retry429,
    onRetry: (info) => {
      handshake.retries += 1;
      sendSpan.handshakeRetries += 1;
      if (info?.classifier) handshake.classifiers.push(info.classifier);
      const attempt = Number(info?.attempt) || handshake.retries;
      const max = Number(info?.max) || attempts.maxMidstreamRetries;
      emitReconnectProgress({ attempt, max, classifier: info?.classifier });
    },
    onBackoffSlept: (ms) => {
      sendSpan.retryBackoffMs += ms;
    },
  });
}

/**
 * Re-seed the retry attempt's fresh entry with the prior attempt's last
 * successful anchor so _computeDelta sees a non-null lastInputPrefixHash and
 * prev_response_id, keeping the same xAI conversation slot warm instead of
 * cold-starting one per retry.
 */
function reseedCarryForward(ctx, entry, reused) {
  const carryForwardCache = ctx.attempts.state.carryForwardCache;
  if (!carryForwardCache || ctx.opts.auth?.type !== 'xai' || reused) return;
  entry.lastResponseId = carryForwardCache.lastResponseId;
  entry.lastInputPrefixHash = carryForwardCache.lastInputPrefixHash;
  entry.lastInputLen = carryForwardCache.lastInputLen;
  entry.lastRequestSansInput = carryForwardCache.lastRequestSansInput;
  entry.lastRequestInput = carryForwardCache.lastRequestInput;
  entry.lastResponseItems = carryForwardCache.lastResponseItems;
}

export function recordAcquired(ctx, acquired, handshake) {
  const { sendSpan } = ctx;
  const { poolKey, traceProvider, useModel } = ctx.opts;
  const { entry, reused } = acquired;
  sendSpan.poolAcquireMs += performance.now() - handshake.start;
  sendSpan.poolOwnerWaitMs += Math.max(0, Number(acquired?.ownerWaitMs) || 0);
  sendSpan.acquireMode =
    [
      [acquired.prewarmed, 'prewarmed'],
      [entry?.ephemeral, 'ephemeral'],
      [reused, 'reused'],
    ].find(([hit]) => hit)?.[1] ?? 'new';
  reseedCarryForward(ctx, entry, reused);
  traceAgentFetch({
    sessionId: poolKey,
    headersMs: performance.now() - handshake.start,
    httpStatus: reused ? 0 : 101,
    provider: traceProvider,
    model: useModel,
    transport: 'websocket',
    handshakeRetries: handshake.retries,
    handshakeRetryClassifiers: handshake.classifiers,
  });
}
