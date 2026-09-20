// The Goal as the user should see it: the raw record with the archive-in-flight
// mask applied. A user prompt retires completed AND stopped work (see
// archiveCompletedGoalOnUserInput), so both stay masked until that archive
// write lands; the raw record still holds the finished Goal in that window.
import { clean } from '../../../runtime/shared/clean.mjs';

const ARCHIVED_STATUSES = ['complete', 'stopped'];

export function createGoalVisibility({ runtime, getState, set }) {
  let suppressedGoalId = '';

  const visibleGoal = (goal) =>
    ARCHIVED_STATUSES.includes(goal?.status) && clean(goal.id) === suppressedGoalId ? null : goal || null;

  // The ONE way this controller writes the Goal lane: every publisher (route
  // pulse, turn boundary, continuation check) passes through the archive mask,
  // so retired chrome cannot pop back for a frame and vanish again.
  const publishGoal = (raw) => {
    const goal = visibleGoal(raw || null);
    if (getState().goal !== goal) set({ goal });
    return goal;
  };

  return {
    visibleGoal,
    publishGoal,
    refreshGoalState: () => publishGoal(runtime.goalStatus?.() || null),
    visibleGoalStatus: () => visibleGoal(runtime.goalStatus?.() || null),
    // Id of a finished Goal that a user prompt retires, or ''.
    archivedGoalId: (goal) => (ARCHIVED_STATUSES.includes(goal?.status) ? clean(goal.id) : ''),
    suppress(goalId) {
      suppressedGoalId = goalId;
    },
    release(goalId) {
      if (suppressedGoalId === goalId) suppressedGoalId = '';
    },
  };
}
