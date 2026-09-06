import { createContext, useContext, useRef } from "react";
import type { GoalSnapshot } from "./desktop-types";

export const GoalSubmissionContext = createContext("");

// Clock/transport publications are not a new goal. Only an actual change to
// its identity, lifecycle, or work should release the previous-turn mask.
function goalRevision(goal: GoalSnapshot | null): string {
  if (!goal) return "";
  return JSON.stringify([
    goal.id, goal.createdAt, goal.status, goal.title, goal.objective,
    goal.tasks, goal.tasksUpdatedAt, goal.tasksCompleted, goal.tasksTotal,
    goal.blocker, goal.completedAt,
  ]);
}

/** The goal's own snapshot owner decides when its old chrome is superseded.
 * A transcript acknowledgement must not reveal a stale goal lane again. */
export function useGoalAfterSubmission(goal: GoalSnapshot | null, sessionId: string) {
  const submission = useContext(GoalSubmissionContext);
  const revision = goalRevision(goal);
  const complete = goal?.status === "complete";
  const state = useRef({ sessionId, submission, revision, complete, suppressed: "" });
  const previous = state.current;
  let suppressed = previous.sessionId === sessionId ? previous.suppressed : "";
  if (submission !== previous.submission && previous.sessionId === sessionId) {
    // A next-turn prompt retires completed work, not a continuing or paused
    // goal. This decision belongs to the goal lane, never the diff lane.
    suppressed = submission && previous.complete ? previous.revision : "";
  }
  if (revision !== suppressed) suppressed = "";
  state.current = { sessionId, submission, revision, complete, suppressed };
  return suppressed ? null : goal;
}
