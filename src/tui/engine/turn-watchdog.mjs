// Lead-turn stall watchdog. A turn is declared stuck only when NOTHING has
// progressed for the timeout: local deltas mark progress directly, and before
// tripping we re-read the orchestrator's own liveness so a long-but-alive tool
// (its self-deadline plus a grace ceiling) defers the trip instead of aborting
// real work. Extracted from turn.mjs; the trip ACTION stays there because it
// unwinds turn-scoped UI state.
export function createTurnWatchdog({
  runtime,
  timeoutMs,
  toolMaxMs,
  isCurrentTurn,
  onTrip,
}) {
  let timer = null;
  let tripped = false;
  let lastProgressAt = Date.now();
  let lastProgressLabel = 'start';
  // While a tool runs, the trip is deferred until this wall-clock ceiling.
  let deferralCeilingAt = 0;

  function clear() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  // Adopt the orchestrator's liveness as progress when it is fresher than the
  // local view; returns true when the trip was deferred.
  function refreshFromRuntimeLiveness() {
    let liveness;
    try { liveness = runtime.getTurnLiveness?.(); } catch { return false; }
    if (liveness?.stage !== 'tool_running') deferralCeilingAt = 0;
    const progressAt = Number(liveness?.lastProgressAt);
    const now = Date.now();
    if (!liveness || !Number.isFinite(progressAt) || progressAt <= now - timeoutMs) return false;

    if (liveness.stage === 'tool_running') {
      deferralCeilingAt = 0;
      const toolStartedAt = Number(liveness.toolStartedAt);
      if (!Number.isFinite(toolStartedAt) || toolStartedAt <= 0) return false;
      const toolSelfDeadlineMs = Number(liveness.toolSelfDeadlineMs);
      const toolCeilingMs = Math.max(
        Number.isFinite(toolSelfDeadlineMs) && toolSelfDeadlineMs > 0 ? toolSelfDeadlineMs + 60_000 : 0,
        toolMaxMs,
      );
      if (now - toolStartedAt >= toolCeilingMs) return false;
      deferralCeilingAt = toolStartedAt + toolCeilingMs;
    }

    lastProgressAt = progressAt;
    lastProgressLabel = `orchestrator:${String(liveness.stage || 'unknown')}`;
    arm();
    return true;
  }

  function arm() {
    clear();
    if (tripped) return;
    const now = Date.now();
    const remaining = Math.max(1, timeoutMs - Math.max(0, now - lastProgressAt));
    const ceilingRemaining = deferralCeilingAt > 0 ? Math.max(1, deferralCeilingAt - now) : Infinity;
    timer = setTimeout(() => {
      if (!isCurrentTurn() || tripped) return;
      const firedAt = Date.now();
      const idleMs = firedAt - lastProgressAt;
      if (idleMs < timeoutMs) {
        if (deferralCeilingAt > 0 && firedAt >= deferralCeilingAt) {
          if (refreshFromRuntimeLiveness()) return;
        } else {
          arm();
          return;
        }
      } else if (refreshFromRuntimeLiveness()) return;
      tripped = true;
      onTrip({ idleMs, lastProgressLabel });
    }, Math.min(remaining, ceilingRemaining));
    timer.unref?.();
  }

  function markProgress(label) {
    if (!isCurrentTurn()) return false;
    if (tripped) return false;
    lastProgressAt = Date.now();
    lastProgressLabel = String(label || 'progress');
    return true;
  }

  return {
    arm,
    clear,
    markProgress,
    get tripped() { return tripped; },
  };
}
