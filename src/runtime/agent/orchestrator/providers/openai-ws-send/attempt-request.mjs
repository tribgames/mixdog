/**
 * attempt-request.mjs — what one attempt puts on the wire: the request body
 * after recovery policies, the shared stream state, the attempt record the
 * outcome trace reports on, the optional startup warmup and the framed
 * delta request.
 */
import { _computeDelta, _estimateFrameTokens } from '../openai-ws-stream.mjs';
import { _metadataTrace, _withCodexWsClientMetadata } from '../openai-codex-metadata.mjs';
import { runStartupWarmup } from '../openai-ws-warmup.mjs';
import { probeFramePrefix } from '../openai-ws-send-outcome.mjs';
import { _applyReasoningReplayPolicy } from './reasoning-replay.mjs';

export function prepareRequestBody(ctx, entry, attemptIndex) {
  const { body, auth } = ctx.opts;
  const { carryForwardCache, suppressReasoningReplay } = ctx.attempts.state;
  let requestBody = body;
  // Mid-stream retry: pin prev_id in the body so _computeDelta's
  // mode='full' fallback (triggered when the carried prefix hash no
  // longer matches the current input) still carries the conversation
  // anchor. The delta path overwrites this from entry.lastResponseId,
  // which equals the carried value, so the two paths agree.
  if (carryForwardCache && auth?.type === 'xai' && attemptIndex > 0 && !body.previous_response_id) {
    requestBody = { ...body, previous_response_id: carryForwardCache.lastResponseId };
  }
  // Recovery-only reasoning replay: decide per entry whether retained
  // reasoning items ride this chain (see _applyReasoningReplayPolicy).
  // Must run BEFORE _computeDelta and the post-send bookkeeping so
  // entry.lastRequestInput always records the post-policy input.
  return _applyReasoningReplayPolicy(entry, requestBody, { suppress: suppressReasoningReplay });
}

/**
 * midState is shared between warmup and the main stream so warmup failures
 * (first-byte timeout, send-failure, ws_4000) flow through the SAME
 * mid-stream classifier as the main send. A wedged warmup socket must not
 * bypass the retry loop and surface raw to the caller — release the entry,
 * force a fresh acquire, and retry.
 */
export function createMidState(ctx, attemptIndex) {
  const { poolKey, iteration, useModel, traceProvider } = ctx.opts;
  return {
    attemptIndex,
    sawResponseCreated: false,
    sawCompleted: false,
    // Gateway live-text relay invariant (see _streamResponse): set once
    // a non-empty text chunk has been forwarded to the client.
    emittedText: false,
    sessionId: poolKey,
    iteration,
    model: useModel,
    traceProvider,
  };
}

/** Per-attempt facts the outcome trace reports on. */
export function createAttemptRecord({ attemptIndex, reused, handshake, startupWarmupResponseId }) {
  return {
    attemptIndex,
    reused,
    handshakeRetries: handshake.retries,
    handshakeRetryClassifiers: handshake.classifiers,
    startupWarmupResponseId,
    sseStart: Date.now(),
    warmupResult: null,
    mode: 'full',
    frame: null,
    deltaTokens: 0,
    deltaReason: null,
    strippedResponseItems: 0,
    skippedResponseItems: 0,
    responseOutputMismatch: null,
    requestInputMismatch: null,
    wireFrameHadTurnState: false,
    wireFrameMetadataTrace: _metadataTrace(null),
    framePrefix: { hash: null, headHash: null, prevMatch: null },
  };
}

export async function runAttemptWarmup(ctx, { entry, attemptIndex, midState, attempt }) {
  const {
    warmupBody,
    externalSignal,
    logSuppressedReasoningDeltas,
    traceProvider,
    poolKey,
    iteration,
    useModel,
    _sendFrameFn,
    _streamFn,
    _agentTraceFn,
  } = ctx.opts;
  const warmup = await runStartupWarmup({
    entry,
    warmupBody,
    attemptIndex,
    codexMetadataContext: ctx.codexMetadataContext,
    useCodexWsClientMetadata: ctx.useCodexWsClientMetadata,
    sendSpan: ctx.sendSpan,
    externalSignal,
    logSuppressedReasoningDeltas,
    traceProvider,
    poolKey,
    iteration,
    useModel,
    midState,
    streamTimeouts: null,
    sendFrame: _sendFrameFn,
    streamFn: _streamFn,
    agentTraceFn: _agentTraceFn,
  });
  attempt.warmupResult = warmup.warmupResult;
  attempt.wireFrameHadTurnState = warmup.wireFrameHadTurnState;
  attempt.wireFrameMetadataTrace = warmup.wireFrameMetadataTrace;
  ctx.warmup.completed = warmup.completedWarmup;
}

/**
 * A completed generate:false prewarm is a valid continuation anchor. Compute
 * against its retained empty-input snapshot so the first real request sends
 * previous_response_id plus exactly the real incremental input. _computeDelta
 * still retreats to a full frame on every missing anchor/property/prefix/output
 * mismatch.
 */
export function buildWireFrame(ctx, attempt, entry, requestBody) {
  const { traceProvider } = ctx.opts;
  const delta = _computeDelta({ entry, body: requestBody, traceProvider });
  attempt.mode = delta.mode;
  attempt.frame = delta.frame;
  attempt.deltaReason = delta.reason || null;
  attempt.strippedResponseItems = delta.strippedResponseItems || 0;
  attempt.skippedResponseItems = delta.skippedResponseItems || 0;
  attempt.responseOutputMismatch = delta.responseOutputMismatch || null;
  attempt.requestInputMismatch = delta.requestInputMismatch || null;
  const wireFrame = _withCodexWsClientMetadata(
    delta.frame,
    entry,
    ctx.useCodexWsClientMetadata,
    ctx.codexMetadataContext
  );
  attempt.wireFrameHadTurnState = !!wireFrame?.client_metadata?.['x-codex-turn-state'];
  attempt.wireFrameMetadataTrace = _metadataTrace(wireFrame?.client_metadata);
  attempt.deltaTokens = _estimateFrameTokens(wireFrame);
  attempt.framePrefix = probeFramePrefix(entry, delta.frame, requestBody);
  return wireFrame;
}
