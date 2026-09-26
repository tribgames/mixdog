// Goal lane controller of one TUI session: reacts to Goal status changes,
// publishes the visible Goal, queues continuations while the Goal is active
// and delivers deadline notices.
import { clean } from '../../runtime/shared/clean.mjs';
import { createGoalVisibility } from './goal-continuation/goal-visibility.mjs';
import { createContinuationQueue } from './goal-continuation/continuation-queue.mjs';
import { createDeadlineDelivery } from './goal-continuation/deadline-delivery.mjs';

export function createGoalContinuation({ runtime, flags, getState, set, getPending, enqueue } = {}) {
  let observedGoalId = clean(getState().goal?.id);
  let observedGoalStatus = clean(getState().goal?.status);
  const visibility = createGoalVisibility({ runtime, getState, set });
  const queue = createContinuationQueue({ runtime, flags, getState, getPending, enqueue, visibility });
  const deadline = createDeadlineDelivery({ runtime, getState, getPending, enqueue, halted: queue.halted });

  const onGoalChanged = (event = {}) => {
    const currentSessionId = clean(getState().sessionId || runtime.id);
    if (clean(event.sessionId) && clean(event.sessionId) !== currentSessionId) return;
    const raw = event.goal || runtime.goalStatus?.() || null;
    const goal = visibility.visibleGoal(raw);
    // Deadline notices tell the model the time used NOW; the lane's goal is
    // anchored at its clock start, so they read the unmasked live record.
    const timed = goal ? raw : null;
    const reached =
      goal?.status === 'duration_reached' && clean(goal.id) === observedGoalId && observedGoalStatus === 'active';
    observedGoalId = clean(goal?.id);
    observedGoalStatus = clean(goal?.status);
    queue.cancelQueuedGoalContinuations({ keepCloseoutFor: goal });
    set({ goal });
    deadline.deliverGoalDeadlineWarning(timed);
    // The durable stop state is already published. Preserve the running turn
    // so it can close out; a closeout is not another Goal work continuation.
    if (reached) deadline.deliverGoalCloseout(timed);
    if (goal?.status === 'active') queue.scheduleGoalContinuation();
  };

  const unsubscribe = runtime.onGoalStatusChange?.(onGoalChanged) || (() => {});

  return {
    cancelQueuedGoalContinuations: queue.cancelQueuedGoalContinuations,
    refreshGoalState: visibility.refreshGoalState,
    // Route publications read this instead of the record, so a retiring
    // completed Goal cannot reappear between the user's prompt and its
    // archive write.
    visibleGoalStatus: visibility.visibleGoalStatus,
    scheduleGoalContinuation: queue.scheduleGoalContinuation,
    shouldRunGoalContinuation: queue.shouldRunGoalContinuation,
    async onGoalTurnStarted() {
      const goal = await Promise.resolve(runtime.goalTurnStarted?.());
      if (goal !== undefined) visibility.publishGoal(goal);
      return goal;
    },
    async onGoalTurnSettled(detail = {}) {
      const status = clean(typeof detail === 'string' ? detail : detail.status).toLowerCase();
      const goal = await Promise.resolve(runtime.goalTurnSettled?.(typeof detail === 'string' ? { status } : detail));
      if (goal !== undefined) visibility.publishGoal(goal);
      if (goal?.status === 'active') queue.scheduleGoalContinuation();
      return goal;
    },
    archiveCompletedGoalOnUserInput() {
      const removed = queue.cancelQueuedGoalContinuations();
      const currentGoal = getState().goal || runtime.goalStatus?.() || null;
      if (removed && currentGoal?.status === 'duration_reached') {
        runtime.markGoalReminder?.('deadline-reached');
      }
      const archivedGoalId = visibility.archivedGoalId(currentGoal);
      if (archivedGoalId) {
        visibility.suppress(archivedGoalId);
        set({ goal: null });
      }
      const settle = () => {
        visibility.release(archivedGoalId);
        visibility.refreshGoalState();
      };
      void Promise.resolve(runtime.archiveCompletedGoalOnUserInput?.()).then(settle).catch(settle);
    },
    disposeGoalContinuation() {
      queue.dispose();
      try {
        unsubscribe();
      } catch {}
    },
  };
}
