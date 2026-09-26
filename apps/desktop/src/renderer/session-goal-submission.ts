import { createContext, createElement, useContext, useRef, type ReactNode } from 'react';
import type { GoalSnapshot } from './desktop-types';

export const GoalSubmissionContext = createContext('');

// Kept outside SessionGoalIsland so the composer can mount the host while the
// capsule module loads only for a session that has a Goal.
export function SessionGoalHost({
  placement,
  children,
  submissionId = '',
}: {
  placement: 'composer';
  children?: ReactNode;
  submissionId?: string;
}) {
  return createElement(
    GoalSubmissionContext.Provider,
    { value: submissionId },
    createElement('div', { className: 'session-goal-host', 'data-goal-placement': placement }, children)
  );
}

// Clock/transport publications are not a new goal. Only an actual change to
// its identity, lifecycle, or work should release the previous-turn mask.
function goalRevision(goal: GoalSnapshot | null): string {
  if (!goal) return '';
  return JSON.stringify([
    goal.id,
    goal.createdAt,
    goal.status,
    goal.title,
    goal.objective,
    goal.tasks,
    goal.tasksUpdatedAt,
    goal.tasksCompleted,
    goal.tasksTotal,
    goal.blocker,
    goal.completedAt,
  ]);
}

/** The goal's own snapshot owner decides when its old chrome is superseded.
 * A transcript acknowledgement must not reveal a stale goal lane again. */
export function useGoalAfterSubmission(goal: GoalSnapshot | null, sessionId: string) {
  const submission = useContext(GoalSubmissionContext);
  const revision = goalRevision(goal);
  const complete = goal?.status === 'complete' || goal?.status === 'stopped';
  const state = useRef({ sessionId, submission, revision, complete, suppressed: '' });
  const previous = state.current;
  let suppressed = previous.sessionId === sessionId ? previous.suppressed : '';
  if (submission !== previous.submission && previous.sessionId === sessionId) {
    // A next-turn prompt retires completed work, not a continuing or paused
    // goal. This decision belongs to the goal lane, never the diff lane.
    suppressed = submission && previous.complete ? previous.revision : '';
  }
  if (revision !== suppressed) suppressed = '';
  state.current = { sessionId, submission, revision, complete, suppressed };
  return suppressed ? null : goal;
}
