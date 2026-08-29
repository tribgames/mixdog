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
  let suppressedCompletedGoalId = '';

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

  const visibleGoal = (goal) => (
    goal?.status === 'complete' && clean(goal.id) === suppressedCompletedGoalId
      ? null
      : goal || null
  );

  const refreshGoalState = () => {
    const goal = visibleGoal(runtime.goalStatus?.() || null);
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
    const goal = visibleGoal(event.goal || runtime.goalStatus?.() || null);
    set({ goal });
    if (goal?.status === 'active') scheduleGoalContinuation();
  };

  const unsubscribe = runtime.onGoalStatusChange?.(onGoalChanged) || (() => {});

  return {
    cancelQueuedGoalContinuations,
    refreshGoalState,
    scheduleGoalContinuation,
    shouldRunGoalContinuation,
    async onGoalTurnStarted() {
      const goal = await Promise.resolve(runtime.goalTurnStarted?.());
      if (goal !== undefined && getState().goal !== goal) set({ goal: goal || null });
      return goal;
    },
    async onGoalTurnSettled(detail = {}) {
      const status = clean(typeof detail === 'string' ? detail : detail.status).toLowerCase();
      const goal = await Promise.resolve(runtime.goalTurnSettled?.(
        typeof detail === 'string' ? { status } : detail,
      ));
      if (goal !== undefined && getState().goal !== goal) set({ goal: goal || null });
      if (status === 'done' && goal?.status === 'active') scheduleGoalContinuation();
      return goal;
    },
    archiveCompletedGoalOnUserInput() {
      cancelQueuedGoalContinuations();
      const currentGoal = getState().goal || runtime.goalStatus?.() || null;
      // The reply a paused Goal was waiting for has arrived. A paused Goal gets
      // no continuation prompt, so without this one state reminder nothing
      // would tell the next turn there is a Goal to resume.
      if (currentGoal?.status === 'paused') {
        try { runtime.markGoalReminder?.('paused'); }
        catch { /* best-effort: a reminder must never block user input */ }
      }
      const archivedGoalId = currentGoal?.status === 'complete' ? clean(currentGoal.id) : '';
      if (archivedGoalId) {
        suppressedCompletedGoalId = archivedGoalId;
        set({ goal: null });
      }
      void Promise.resolve(runtime.archiveCompletedGoalOnUserInput?.())
        .then(() => {
          if (suppressedCompletedGoalId === archivedGoalId) suppressedCompletedGoalId = '';
          refreshGoalState();
        })
        .catch(() => {
          if (suppressedCompletedGoalId === archivedGoalId) suppressedCompletedGoalId = '';
          refreshGoalState();
        });
    },
    disposeGoalContinuation() {
      disposed = true;
      if (scheduled) clearImmediate(scheduled);
      scheduled = null;
      try { unsubscribe(); } catch {}
    },
  };
}
