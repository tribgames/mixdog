// Queued Goal continuations: cancellation of queued Goal entries, the check a
// queued entry passes before it runs, and the deferred enqueue of the next
// continuation prompt once the session is idle.
import { clean } from '../../../runtime/shared/clean.mjs';
import { goalDeadlineReached } from '../../../session-runtime/goal-text.mjs';
import { isGoalQueuedEntry } from '../queue-helpers.mjs';

export function createContinuationQueue({ runtime, flags, getState, getPending, enqueue, visibility }) {
  let scheduled = null;
  let disposed = false;
  const halted = () => disposed || flags.disposed || flags.pendingSessionReset;

  const cancelQueuedGoalContinuations = ({ keepCloseoutFor = null } = {}) => {
    const pending = getPending();
    let removed = 0;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      if (!isGoalQueuedEntry(entry)) continue;
      if (
        entry.mode === 'goal-closeout' &&
        keepCloseoutFor?.status === 'duration_reached' &&
        clean(entry.goalId) === clean(keepCloseoutFor.id)
      ) {
        entry.content = goalDeadlineReached(keepCloseoutFor);
        continue;
      }
      pending.splice(index, 1);
      removed += 1;
    }
    return removed;
  };

  const continuationDecision = () => {
    const decision = runtime.goalContinuation?.() || { run: false, reason: 'unavailable', goal: null };
    visibility.publishGoal(decision.goal);
    return decision;
  };

  const shouldRunGoalContinuation = (entry) => {
    if (halted()) return false;
    if (getState().sessionRemoteAttached) return false;
    if (entry?.mode === 'goal-closeout') {
      const goal = visibility.refreshGoalState();
      return goal?.status === 'duration_reached' && clean(entry.goalId) === clean(goal.id);
    }
    const decision = continuationDecision();
    if (!decision.run) return false;
    const queuedGoalId = clean(entry?.goalId);
    return !queuedGoalId || queuedGoalId === clean(decision.goal?.id);
  };

  const scheduleGoalContinuation = () => {
    if (disposed || scheduled) return false;
    scheduled = setImmediate(() => {
      scheduled = null;
      if (halted()) return;
      const state = getState();
      if (state.busy || state.commandBusy || state.sessionRemoteAttached) return;
      const pending = getPending();
      if (pending.some((entry) => !isGoalQueuedEntry(entry))) return;
      if (pending.some(isGoalQueuedEntry)) return;
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

  return {
    halted,
    cancelQueuedGoalContinuations,
    shouldRunGoalContinuation,
    scheduleGoalContinuation,
    dispose() {
      disposed = true;
      if (scheduled) clearImmediate(scheduled);
      scheduled = null;
    },
  };
}
