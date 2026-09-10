import { clean } from '../../runtime/shared/clean.mjs';
import { goalDeadlineWarning } from '../../session-runtime/goal-text.mjs';

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
  let watchedGoalId = '';
  let deliveredWarningRevision = 0;

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

  // The budget stop aborts the running turn, so the warning has to reach the
  // model while that turn still has minutes left: a busy session steers it in
  // mid-turn (the loop attaches `next` entries at the next tool batch), and an
  // idle one parks the durable reminder for whatever turn comes next.
  const deliverGoalDeadlineWarning = (goal) => {
    const revision = Math.max(0, Number(goal?.warningRevision) || 0);
    const goalId = clean(goal?.id);
    // Warnings this Goal earned before this controller existed were delivered
    // by whoever ran the session then, so the first sighting only sets the
    // watermark. Watching from the Goal's own start keeps the first crossing.
    if (goalId && goalId !== watchedGoalId) {
      watchedGoalId = goalId;
      deliveredWarningRevision = revision;
      return;
    }
    if (!revision || revision <= deliveredWarningRevision) return;
    deliveredWarningRevision = revision;
    if (clean(goal?.status) !== 'active' || !(Number(goal?.remainingMs) > 0)) return;
    const text = goalDeadlineWarning(goal);
    if (!clean(text)) return;
    const state = getState();
    if (state.busy || state.commandBusy) {
      // A queued prompt is the only entry shape the loop attaches mid-turn,
      // so the warning rides that contract: `isMeta` keeps it out of the
      // queued-command list and `suppressDisplay` renders no user bubble while
      // the model still receives the reminder content.
      enqueue(text, {
        mode: 'prompt',
        priority: 'next',
        isMeta: true,
        suppressDisplay: true,
        skipSlashCommands: true,
        restorable: false,
        goalId: clean(goal.id),
        displayText: '',
      });
      return;
    }
    try { runtime.markGoalReminder?.('deadline-soon'); } catch { /* best-effort: a reminder must never break the session */ }
  };

  const onGoalChanged = (event = {}) => {
    const currentSessionId = clean(getState().sessionId || runtime.id);
    if (clean(event.sessionId) && clean(event.sessionId) !== currentSessionId) return;
    cancelQueuedGoalContinuations();
    const goal = visibleGoal(event.goal || runtime.goalStatus?.() || null);
    set({ goal });
    deliverGoalDeadlineWarning(goal);
    if (goal?.status === 'duration_reached' && getState().busy
      && !getState().sessionRemoteAttached) runtime.abort?.('goal-budget');
    if (goal?.status === 'active') scheduleGoalContinuation();
  };

  const unsubscribe = runtime.onGoalStatusChange?.(onGoalChanged) || (() => {});

  return {
    cancelQueuedGoalContinuations,
    refreshGoalState,
    /** The Goal as the user should see it right now: the raw record with the
     *  archive-in-flight mask applied. Route publications read this instead
     *  of the record, so a retiring completed Goal cannot reappear between
     *  the user's prompt and its archive write. */
    visibleGoalStatus: () => visibleGoal(runtime.goalStatus?.() || null),
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
      if (goal?.status === 'active') scheduleGoalContinuation();
      return goal;
    },
    archiveCompletedGoalOnUserInput() {
      cancelQueuedGoalContinuations();
      const currentGoal = getState().goal || runtime.goalStatus?.() || null;
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
