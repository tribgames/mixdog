/**
 * stream-failure-stamps.mjs — what a post-acquire failure leaves behind
 * before the retry decision: the xAI conversation anchor, the released
 * socket, the cross-attempt no-replay latches and the canonical outcome.
 */
import { stampStreamOutcome, STREAM_TRANSPORTS } from '../lib/stream-outcome.mjs';
import { releaseWebSocket } from '../openai-ws-pool.mjs';
import { tag } from './policy.mjs';

/**
 * Snapshot the xAI conversation anchor BEFORE releasing the entry. release
 * closes the socket but leaves state fields intact; the next forceFresh
 * acquire creates a new entry into which we manually carry the anchor so the
 * retry continues the same conversation instead of cold-starting one. Only a
 * STORED response survives its connection. xAI's default (store:false)
 * continuation is in-connection state: replaying its previous_response_id
 * onto the fresh socket the retry acquires fails with a missing-response
 * anchor and burns the recovery attempt, so a non-stored anchor is dropped
 * and the retry cold-starts the conversation with the full input instead.
 */
function carryForwardAnchor(ctx, entry) {
  const { auth, body } = ctx.deps;
  if (auth?.type !== 'xai' || !entry.lastResponseId || body?.store !== true) return;
  ctx.state.carryForwardCache = {
    lastResponseId: entry.lastResponseId,
    lastInputPrefixHash: entry.lastInputPrefixHash,
    lastInputLen: entry.lastInputLen,
    lastRequestSansInput: entry.lastRequestSansInput,
    lastRequestInput: entry.lastRequestInput,
    lastResponseItems: entry.lastResponseItems,
  };
}

/**
 * Live-text invariant: a non-empty chunk already relayed to the client
 * cannot be withdrawn. Latch across attempts: even though THIS error is never
 * retry-eligible once text is out, a later/earlier surfaced error
 * (firstAttemptError) must still carry the marker, so the upstream HTTP
 * fallback gate also refuses to re-issue and concatenate attempts.
 *
 * Reasoning deltas and an in-progress tool input are already observable turn
 * progress even though neither is final assistant text nor a dispatched tool
 * call. Reissuing from the beginning can duplicate exposed thinking/tool
 * argument streams and can make a partially generated side-effecting call
 * diverge. Keep the Codex retry budget only for failures before any such
 * model output. Exposed reasoning is a visibility boundary. A tool call that
 * only STARTED assembling was never dispatched, so it is recorded but is NOT
 * a side effect and must not veto a retry.
 */
function latchExposure(ctx, err, midState) {
  const { safetyStamps } = ctx.deps;
  if (midState.emittedText) safetyStamps.markText();
  if (midState.emittedToolCall) safetyStamps.markTool();
  if (midState.emittedReasoning) tag(err, { unsafeToRetry: true, partialReasoningEmitted: true });
  if (midState.startedToolCall) tag(err, { partialToolCallStarted: true });
  ctx.stampAll(err);
}

export function stampStreamFailure(ctx, err, { entry, midState }) {
  ctx.deps.stampWarmup(err);
  // Preserve failure provenance for the direct provider. This marker is
  // observational for OAuth and does not change its classifier or retry
  // budget.
  tag(err, { wsFailurePhase: 'stream' });
  carryForwardAnchor(ctx, entry);
  releaseWebSocket({ entry, poolKey: ctx.deps.trace.poolKey, keep: false });
  latchExposure(ctx, err, midState);
  // Canonical stream-outcome record for the WS transport, merged with the
  // cross-attempt safety latches above. _streamResponse already stamps its
  // own reject paths; this covers frame-send / handshake-adjacent failures
  // that never reached the stream loop.
  try {
    stampStreamOutcome(err, midState, {
      transport: STREAM_TRANSPORTS.WS,
      provider: 'openai-oauth',
      continuation: midState.sawCompleted !== true,
    });
  } catch {
    /* stamping is best-effort */
  }
}
