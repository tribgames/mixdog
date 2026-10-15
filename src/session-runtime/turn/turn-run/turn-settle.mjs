import { throwIfAborted } from '../../../runtime/shared/abort-race.mjs';

/** The StopFailure hook's error class, read from the failure message. */
function stopFailureType(message) {
  if (/rate.?limit|\b429\b|too many requests/.test(message)) return 'rate_limit';
  if (/overloaded|\b529\b/.test(message)) return 'overloaded';
  if (/authenticat|unauthorized|\b401\b|invalid.*api.?key/.test(message)) return 'authentication_failed';
  if (/server.?error|\b5\d\d\b|internal error/.test(message)) return 'server_error';
  return 'unknown';
}

// Turn completion (session refresh, final transcript row, Stop hook), error
// reporting (turn:error + StopFailure) and the settlement that always runs.
export function createTurnSettlement({
  getSession,
  setSession,
  mgr,
  transcript,
  sessionTitles,
  hooks,
  hookCommonPayload,
  agentTool,
  endComputerExecution,
  deferComputerSessionRelease,
  getActiveTurnCount,
  setActiveTurnCount,
  isFirstTurnCompleted,
  setFirstTurnCompleted,
  scheduleProviderWarmup,
  scheduleProviderModelWarmup,
  takePendingCompact,
  runPendingCompact,
}) {
  async function completeTurn(turn, session0, result) {
    throwIfAborted(turn.signal);
    if (!turn.timing.emitted) turn.timing.status = 'complete-no-delta';
    setSession(mgr.getSession(session0.id) || getSession());
    try {
      sessionTitles?.observeThird(getSession());
    } catch {
      /* title refresh is best-effort */
    }
    transcript.appendFinalAssistant(result);
    hooks.emit('turn:end', { sessionId: session0.id, elapsedMs: Date.now() - turn.startedAt });
    try {
      await turn.awaitTurn(() => hooks.dispatch('Stop', hookCommonPayload({ session_id: session0.id })));
    } catch {
      throwIfAborted(turn.signal);
      // Ordinary Stop hook failure is best-effort.
    }
    return { result, session: getSession() };
  }

  function reportTurnError(turn, error) {
    hooks.emit('turn:error', {
      sessionId: getSession()?.id || null,
      elapsedMs: Date.now() - turn.startedAt,
      error: error?.message || String(error),
    });
    try {
      const errorType = stopFailureType(String(error?.message || error || '').toLowerCase());
      void hooks.dispatch(
        'StopFailure',
        hookCommonPayload({ session_id: getSession()?.id || null, error_type: errorType })
      );
    } catch {
      /* best-effort: StopFailure hook must never break teardown */
    }
  }

  async function releaseComputerUse(sessionId) {
    try {
      await endComputerExecution(sessionId);
    } catch {
      /* visual Computer Use teardown never overrides turn settlement */
    }
    try {
      deferComputerSessionRelease(sessionId);
    } catch {
      /* deferred computer lease cleanup never overrides turn settlement */
    }
  }

  async function settleTurn(turn) {
    await releaseComputerUse(turn.session0?.id);
    turn.releaseFirstTitle?.();
    turn.emitTiming(turn.timing.status);
    turn.armHeavyRuntimeWarmup('turn-settled');
    try {
      await turn.snapshot.finish(turn.signal, turn.awaitTurn);
    } finally {
      // The turn no longer works in its checkout: transitions may proceed.
      turn.releaseWorkspace?.();
    }
    try {
      turn.unregister?.();
    } catch {}
    try {
      agentTool?.upsertLeadSession?.(getSession() || turn.session0, { status: 'idle', stage: 'idle' });
    } catch {
      /* lead pool must never break turn teardown */
    }
    setActiveTurnCount(Math.max(0, getActiveTurnCount() - 1));
    // A compaction the model scheduled (session tool) runs once the turn is over.
    // Only while the settled session is still the live one; otherwise it stays
    // pending for that session and never compacts another. The runner chains
    // the compaction so the next turn waits on it.
    const settledId = turn.session0?.id;
    if (getActiveTurnCount() === 0 && settledId && getSession()?.id === settledId && takePendingCompact?.(settledId)) {
      runPendingCompact?.(settledId);
    }
    if (!isFirstTurnCompleted()) {
      setFirstTurnCompleted(true);
      scheduleProviderWarmup();
      scheduleProviderModelWarmup();
    }
  }

  return { completeTurn, reportTurnError, settleTurn };
}
