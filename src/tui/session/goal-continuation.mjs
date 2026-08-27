function clean(value) {
  return String(value ?? '').trim();
}

function isGoalContinuation(entry) {
  return entry?.mode === 'goal-continuation';
}

export function createGoalContinuation({
  runtime,
  flags,
  getState,
  set,
  getPending,
  enqueue,
} = {}) {
  let scheduled = null;
  let disposed = false;

  const cancelQueuedGoalContinuations = () => {
    const pending = getPending();
    let removed = 0;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (!isGoalContinuation(pending[index])) continue;
      pending.splice(index, 1);
      removed += 1;
    }
    return removed;
  };

  const refreshGoalState = () => {
    const goal = runtime.goalStatus?.() || null;
    if (getState().goal !== goal) set({ goal });
    return goal;
  };

  const continuationDecision = () => {
    const decision = runtime.goalContinuation?.() || { run: false, reason: 'unavailable', goal: null };
    if (getState().goal !== decision.goal) set({ goal: decision.goal || null });
    return decision;
  };

  const shouldRunGoalContinuation = (entry) => {
    if (disposed || flags.disposed || flags.pendingSessionReset) return false;
    if (getState().sessionRemoteAttached) return false;
    const decision = continuationDecision();
    if (!decision.run) return false;
    const queuedGoalId = clean(entry?.goalId);
    return !queuedGoalId || queuedGoalId === clean(decision.goal?.id);
  };

  const scheduleGoalContinuation = () => {
    if (disposed || scheduled) return false;
    scheduled = setImmediate(() => {
      scheduled = null;
      if (disposed || flags.disposed || flags.pendingSessionReset) return;
      const state = getState();
      if (state.busy || state.commandBusy || state.sessionRemoteAttached) return;
      const pending = getPending();
      if (pending.some((entry) => !isGoalContinuation(entry))) return;
      if (pending.some(isGoalContinuation)) return;
      const decision = continuationDecision();
      if (!decision.run || !clean(decision.prompt)) return;
      enqueue(decision.prompt, {
        mode: 'goal-continuation',
        priority: 'later',
        isMeta: true,
        suppressDisplay: true,
        skipSlashCommands: true,
        restorable: false,
        goalId: clean(decision.goal?.id),
        displayText: '',
      });
    });
    scheduled.unref?.();
    return true;
  };

  const onGoalChanged = (event = {}) => {
    const currentSessionId = clean(getState().sessionId || runtime.id);
    if (clean(event.sessionId) && clean(event.sessionId) !== currentSessionId) return;
    cancelQueuedGoalContinuations();
    set({ goal: event.goal || runtime.goalStatus?.() || null });
    if ((event.goal || runtime.goalStatus?.())?.status === 'active') scheduleGoalContinuation();
  };

  const unsubscribe = runtime.onGoalStatusChange?.(onGoalChanged) || (() => {});

  return {
    cancelQueuedGoalContinuations,
    refreshGoalState,
    scheduleGoalContinuation,
    shouldRunGoalContinuation,
    onGoalTurnSettled(status) {
      if (status === 'done') scheduleGoalContinuation();
    },
    archiveCompletedGoalOnUserInput() {
      cancelQueuedGoalContinuations();
      void Promise.resolve(runtime.archiveCompletedGoalOnUserInput?.())
        .then(() => refreshGoalState())
        .catch(() => {});
    },
    disposeGoalContinuation() {
      disposed = true;
      if (scheduled) clearImmediate(scheduled);
      scheduled = null;
      try { unsubscribe(); } catch {}
    },
  };
}
