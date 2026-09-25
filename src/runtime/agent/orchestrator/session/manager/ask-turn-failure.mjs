// manager/ask-turn-failure.mjs
// How an ask turn unwinds when it does not commit: cancellation keeps the
// interruption snapshot the user already saw; a provider failure keeps what
// the provider demonstrably produced (or the compacted prompt) and logs one
// durable failure line. Queue entries the turn consumed are acked only when
// their prompt survived, released otherwise.
import { readStreamOutcome } from '../../providers/lib/stream-outcome.mjs';
import { classifyError } from '../../providers/retry-classifier.mjs';
import { saveSessionAsync } from '../store.mjs';
import { settleAskCleanup } from './ask-support.mjs';
import { persistCompactedOutgoingAfterAskFailure } from './message-sanitize.mjs';
import {
  finalizePendingMessageDelivery,
  recordPendingMessageDelivery,
  releasePendingMessages,
} from './pending-messages.mjs';
import { _getRuntimeEntry, markSessionCancelled, markSessionError } from './runtime-liveness.mjs';
import { SessionClosedError } from './session-errors.mjs';
import { clearTurnCheckpoint } from './turn-checkpoint.mjs';

/** Durable failure identity: every surfaced (non-cancel) turn error logs ONE
 *  structured line to stderr — the shard host mirrors it into daemon.log — so
 *  post-hoc diagnosis never depends on the renderer's ephemeral failure
 *  toast. */
function logAskError(sessionId, err, providerOutcome) {
  try {
    const status = Number(err?.httpStatus || err?.status || err?.response?.status || 0) || 0;
    const errorDetails = err?.details && typeof err.details === 'object' ? err.details : null;
    const parts = [
      `session=${sessionId}`,
      `name=${err?.name || 'Error'}`,
      status ? `status=${status}` : null,
      err?.code ? `code=${err.code}` : null,
      err?.providerErrorType ? `type=${err.providerErrorType}` : null,
      `kind=${errorDetails?.kind || classifyError(err)}`,
      errorDetails?.reason ? `reason=${errorDetails.reason}` : null,
      errorDetails?.source ? `source=${errorDetails.source}` : null,
      Number.isFinite(Number(errorDetails?.index)) ? `index=${errorDetails.index}` : null,
      Number.isFinite(Number(errorDetails?.previousCount)) ? `previousCount=${errorDetails.previousCount}` : null,
      Number.isFinite(Number(errorDetails?.nextCount)) ? `nextCount=${errorDetails.nextCount}` : null,
      Number.isFinite(Number(err?.attempts)) ? `attempts=${err.attempts}` : null,
      Number.isFinite(Number(err?.midstreamRetries)) ? `midstreamRetries=${err.midstreamRetries}` : null,
      err?.midstreamClassifier ? `midstream=${err.midstreamClassifier}` : null,
      err?.requestId ? `requestId=${err.requestId}` : null,
      providerOutcome.observedOutput === true ? 'observedOutput=1' : null,
      providerOutcome.replayUnsafe === true ? 'replayUnsafe=1' : null,
      `msg=${JSON.stringify(String(err?.message || err).slice(0, 300))}`,
    ].filter(Boolean);
    process.stderr.write(`[ask-error] ${parts.join(' ')}\n`);
  } catch {
    /* diagnostics must never mask the original failure */
  }
}

/** Saves the finalized session durably and, when the prompt survived, runs
 *  the pending-delivery ledger prune on top of that save. Resolves to
 *  whether the canonical save settled within the cleanup budget. */
async function persistFinalizedSession({ session, sessionId, generation, pendingEntries, promptSurvived }) {
  if (promptSurvived) recordPendingMessageDelivery(session, pendingEntries);
  else releasePendingMessages(sessionId, pendingEntries);
  try {
    const durableSave = saveSessionAsync(session, { expectedGeneration: generation });
    const cleanup = promptSurvived
      ? finalizePendingMessageDelivery(session, pendingEntries, durableSave, () =>
          saveSessionAsync(session, { expectedGeneration: generation })
        )
      : durableSave;
    return (await settleAskCleanup(cleanup)).settled;
  } catch {
    /* cleanup persistence is best-effort */
    return false;
  }
}

/** A SessionClosedError unwind: keeps the interruption snapshot unless the
 *  runtime already closed, in which case the consumed queue entries are
 *  released untouched. */
async function finalizeCancelledTurn({
  sessionId,
  err,
  turn,
  session,
  prepareCloseSnapshot,
  generation,
  turnCheckpointToken,
}) {
  const currentRuntime = _getRuntimeEntry(sessionId);
  if (currentRuntime?.closed || !session) {
    releasePendingMessages(sessionId, turn.pendingEntries);
    if (!currentRuntime?.closed) markSessionCancelled(sessionId);
    return;
  }
  const finalized = prepareCloseSnapshot(err.reason);
  if (currentRuntime?.prepareCloseSnapshot === prepareCloseSnapshot) {
    currentRuntime.prepareCloseSnapshot = null;
  }
  const settled = await persistFinalizedSession({
    session,
    sessionId,
    generation,
    pendingEntries: turn.pendingEntries,
    promptSurvived: finalized.responsePreserved,
  });
  if (settled) clearTurnCheckpoint(sessionId, turnCheckpointToken);
  if (currentRuntime) currentRuntime.session = session;
  markSessionCancelled(sessionId);
}

/**
 * Unwinds one failed turn. Always returns so the caller rethrows `err`.
 * @param {object} input
 * @param {string} input.sessionId
 * @param {Error} input.err
 * @param {object} input.turn            ask turn state (session, outgoing, pendingEntries)
 * @param {object} input.interruption    turn interruption tracker
 * @param {(reason: string) => object|null} input.prepareCloseSnapshot
 * @param {object} input.checkpoint      checkpoint scheduler
 * @param {number} input.generation      the ask generation every save is scoped to
 * @param {string} input.turnCheckpointToken
 * @param {object} input.runtime         the session's runtime entry at turn start
 */
export async function finalizeAskTurnFailure({
  sessionId,
  err,
  turn,
  interruption,
  prepareCloseSnapshot,
  checkpoint,
  generation,
  turnCheckpointToken,
  runtime,
}) {
  checkpoint.stop();
  const session = turn.session;
  // Cancellation/error paths bypass the commit point; drop the live-turn
  // alias so contextStatus() stops estimating from the stale in-flight array
  // once the turn unwinds.
  if (session) {
    session.liveTurnMessages = null;
    delete session.activeTurnCheckpoint;
    // The provider prefix snapshot commits per successful send INSIDE the
    // turn, while the transcript unwinds to its pre-turn/finalized shape
    // below. A surviving mid-turn snapshot flags every retry as
    // history_shrink ("Session state changed unexpectedly."), so it unwinds
    // with the turn.
    delete session._providerPrefixGuardState;
  }
  // Restore before ANY finalization path. In particular, cancellation can
  // race the acknowledged non-streaming restart and surface as a
  // SessionClosedError; its interruption snapshot must include the one
  // partial response that was already exposed.
  const restoredResetText = interruption.restoreTombstonedText();
  if (err instanceof SessionClosedError) {
    // Cancellation is not an error; the caller propagates it silently so
    // surfaces render "cancelled" rather than a red failure.
    await finalizeCancelledTurn({
      sessionId,
      err,
      turn,
      session,
      prepareCloseSnapshot,
      generation,
      turnCheckpointToken,
    });
    return;
  }
  if (runtime.prepareCloseSnapshot === prepareCloseSnapshot) {
    runtime.prepareCloseSnapshot = null;
  }
  // A reset acknowledgement removes the live partial before the
  // non-streaming request starts. If that restart fails, restore the
  // tombstone and persist the one exposed partial as interruption history.
  // Failed/absent acknowledgements never tombstoned it. Provider-specific
  // legacy flags are NOT consulted here: the canonical stream-outcome
  // contract answers "did the provider produce output we must commit?" for
  // every transport. Anthropic's stall/truncation errors carry neither
  // liveTextEmitted nor unsafeToRetry — only partialContent/partialToolCalls
  // — and used to drop the streamed summary from history on that provider.
  const providerOutcome = readStreamOutcome(err);
  const preserveProviderPartial =
    restoredResetText ||
    providerOutcome.observedOutput === true ||
    // Positive exposure evidence only: an error with no observed output
    // must not be mistaken for a turn that produced provider output.
    providerOutcome.replayUnsafe === true ||
    err?.unsafeToRetry === true;
  let errorStateDurable = false;
  if (preserveProviderPartial && session && interruption.hasResponseStarted()) {
    const finalized = prepareCloseSnapshot('provider-error');
    errorStateDurable = await persistFinalizedSession({
      session,
      sessionId,
      generation,
      pendingEntries: turn.pendingEntries,
      promptSurvived: finalized.responsePreserved,
    });
    const currentRuntime = _getRuntimeEntry(sessionId);
    if (currentRuntime) currentRuntime.session = session;
  } else {
    const compactPersist = await settleAskCleanup(
      persistCompactedOutgoingAfterAskFailure({
        sessionId,
        activeSession: session,
        askGeneration: generation,
        turnOutgoing: turn.outgoing,
        error: err,
      })
    );
    const promptPersisted = compactPersist.settled && compactPersist.value === true;
    if (promptPersisted) {
      errorStateDurable = await persistFinalizedSession({
        session,
        sessionId,
        generation,
        pendingEntries: turn.pendingEntries,
        promptSurvived: true,
      });
    } else {
      releasePendingMessages(sessionId, turn.pendingEntries);
    }
  }
  if (!errorStateDurable && session) {
    try {
      errorStateDurable = (await settleAskCleanup(saveSessionAsync(session, { expectedGeneration: generation })))
        .settled;
    } catch {
      /* retain checkpoint when canonical persistence fails */
    }
  }
  if (errorStateDurable) clearTurnCheckpoint(sessionId, turnCheckpointToken);
  logAskError(sessionId, err, providerOutcome);
  markSessionError(sessionId, err?.message ? err.message : String(err));
}
