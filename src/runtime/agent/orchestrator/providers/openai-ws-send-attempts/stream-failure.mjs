/**
 * stream-failure.mjs — decide what a failure after the socket was acquired
 * (frame send, warmup or the stream itself) means for the send: retry on a
 * fresh socket (true) or throw the error to surface.
 */
import {
  markProviderRecoveryExhausted,
  STREAM_STALL_RETRY_BUDGET_MS,
  shouldDropPreviousResponseId,
} from '../retry-classifier.mjs';
import {
  _classifyMidstreamError,
  _mustSurfaceCurrentAttempt,
  isReasoningReplayRejection,
  midstreamRetryLimit,
  tag,
} from './policy.mjs';
import { stampStreamFailure } from './stream-failure-stamps.mjs';
import { chainSocketError } from '../openai-ws-terminal.mjs';

/**
 * Reasoning-replay rejection safety net: a duplicate-rs_ rejection on a frame
 * that carried replayed reasoning gets ONE strip-and-retry within the
 * existing attempt budget instead of failing the recovery turn outright.
 * Unsafe outcomes (live text/tool output) keep their normal no-replay handling.
 */
function stripReasoningReplay(ctx, err, { attemptIndex, entry }) {
  const { state } = ctx;
  if (
    state.suppressReasoningReplay ||
    entry.replayReasoning !== true ||
    err?.unsafeToRetry === true ||
    attemptIndex >= ctx.maxMidstreamRetries ||
    !isReasoningReplayRejection(err)
  ) {
    return false;
  }
  state.suppressReasoningReplay = true;
  ctx.scheduleRetry(err, {
    attemptIndex,
    classifier: 'reasoning_replay_rejected',
    retryLimit: ctx.maxMidstreamRetries,
    remember: true,
  });
  return true;
}

function surfaceExhausted(ctx, err, attemptIndex) {
  const { state } = ctx;
  const first = ctx.surfaceFirstAttempt(attemptIndex, midstreamRetryLimit(state.firstAttemptClassifier), (e) =>
    markProviderRecoveryExhausted(e, { owner: 'openai-oauth-ws-midstream', attempts: attemptIndex + 1 })
  );
  // Keep the retry attempt's error for post-mortem diagnostics instead of
  // silently dropping it: `cause` if free, else `suppressed`.
  chainSocketError(first, err);
  return ctx.surface(first);
}

/**
 * @returns {Promise<true>} the caller starts the next attempt on a fresh socket
 * @throws the error the caller must surface
 */
export async function resolveStreamFailure(ctx, err, { attemptIndex, entry, midState }) {
  const { state } = ctx;
  const { externalSignal, stallRetryBudget } = ctx.deps;
  stampStreamFailure(ctx, err, { entry, midState });
  if (stripReasoningReplay(ctx, err, { attemptIndex, entry })) return true;
  const classifier = err?.unsafeToRetry === true ? null : _classifyMidstreamError(err, midState);
  if (classifier === 'stream_stalled' && !stallRetryBudget.allowStallRetry()) {
    try {
      process.stderr.write(
        `[openai-oauth] stall retry budget exhausted (${STREAM_STALL_RETRY_BUDGET_MS}ms since first stall) — surfacing provider-terminal failure\n`
      );
    } catch {}
    throw ctx.surface(markProviderRecoveryExhausted(err, { owner: 'openai-oauth-ws-stall-budget' }));
  }
  const retryLimit = classifier ? midstreamRetryLimit(classifier) : 0;
  if (classifier && attemptIndex < retryLimit) {
    // Retry-eligible: stash the first-attempt error, emit progress, and
    // loop. The subsequent acquire uses forceFresh so no socket is
    // shared between attempts.
    if (shouldDropPreviousResponseId(err)) {
      state.carryForwardCache = null;
      tag(entry, { lastResponseId: null });
    }
    ctx.scheduleRetry(err, { attemptIndex, classifier, retryLimit, remember: true });
    await ctx.backoff(attemptIndex + 1);
    return true;
  }
  // Not retryable, OR we've already exhausted the retry budget. Do not
  // let stale retry history mask a current auth/upgrade decision,
  // cancellation, or newly unsafe-to-replay outcome.
  if (_mustSurfaceCurrentAttempt(err, externalSignal)) throw ctx.surface(err);
  // Exhausted path: surface the first-attempt error (the one the user's
  // turn actually tripped on), tagged with the actual retry count.
  if (attemptIndex > 0 && state.firstAttemptError) throw surfaceExhausted(ctx, err, attemptIndex);
  throw ctx.surface(err);
}
