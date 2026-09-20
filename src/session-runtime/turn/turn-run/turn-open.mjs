import { runAbortable } from '../../../runtime/shared/abort-race.mjs';

// Opens one turn: abort controller registration, timing, the worktree
// snapshot tracker, the active-turn count and the one-shot heavy-runtime
// warmup arm.
export function createTurnOpener({
  createTiming,
  createSnapshot,
  getSession,
  getReservedSessionId,
  registerActiveTurnController,
  getActiveTurnCount,
  setActiveTurnCount,
  getCodeGraphFirstTurnPrewarmDone,
  setCodeGraphFirstTurnPrewarmDone,
  scheduleToolRuntimeWarmup,
  scheduleCodeGraphPrewarm,
}) {
  // First-turn fallback for hosts that disabled or have not completed the
  // post-connect idle warmup. Do not start it until the provider has produced
  // visible text/reasoning/tool progress: transport headers and
  // response-created acknowledgements arrive earlier and would make PowerShell
  // + graph workers compete with the first-token critical path.
  function heavyRuntimeWarmupArm() {
    const pending = typeof getCodeGraphFirstTurnPrewarmDone === 'function' && !getCodeGraphFirstTurnPrewarmDone();
    if (pending) setCodeGraphFirstTurnPrewarmDone(true);
    let armed = false;
    return (reason) => {
      if (!pending || armed) return;
      armed = true;
      scheduleToolRuntimeWarmup?.(0);
      scheduleCodeGraphPrewarm?.(0, reason);
    };
  }

  return function openTurn(options) {
    const timing = createTiming(options);
    const controller = new AbortController();
    const unregister =
      typeof registerActiveTurnController === 'function' ? registerActiveTurnController(controller) : () => {};
    const signal = controller.signal;
    const snapshot = createSnapshot(options);
    const routeStartedAt = performance.now();
    snapshot.start(getSession()?.id || getReservedSessionId?.());
    setActiveTurnCount(getActiveTurnCount() + 1);
    return {
      signal,
      unregister,
      awaitTurn: (task) => runAbortable(signal, task, 'Turn aborted'),
      timing,
      emitTiming: (status) => timing.emit(status, snapshot.sessionId),
      snapshot,
      routeStartedAt,
      armHeavyRuntimeWarmup: heavyRuntimeWarmupArm(),
      session0: null,
      releaseFirstTitle: null,
      startedAt: Date.now(),
    };
  };
}
