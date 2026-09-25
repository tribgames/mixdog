/**
 * goal-turns.mjs — the Goal's turn lifecycle: opening a turn on the active
 * clock, settling it from the turn outcome, deciding whether an idle session
 * should continue, and retiring finished work on the next user prompt.
 */
import { continuationPrompt } from './goal-text.mjs';
import { GOAL_TASK_SETTLED } from './goal-tool-defs.mjs';
import {
  assertSessionId,
  checkpointActiveClock,
  clearTurnFailures,
  publicGoal,
  runningAgentWork,
  startActiveClock,
  stopActiveClock,
} from './goal-state.mjs';
import { goalFinished } from './goal-mutations.mjs';
import { observeGoal } from './goal-tool-exec.mjs';
import { clean } from '../runtime/shared/clean.mjs';

// Every recorded task is settled while a requested duration still has time.
// Completed rows neither complete the objective nor shorten its duration, so
// this state must not loop the model over an unchanged list.
function settledDurationWait(goal) {
  return (
    goal?.status === 'active' &&
    goal.timeMode === 'duration' &&
    goal.remainingMs > 0 &&
    !goal.needsTaskReview &&
    goal.tasks.length > 0 &&
    goal.tasks.every((task) => GOAL_TASK_SETTLED.includes(task.status)) &&
    goal.blockAudit?.turn !== goal.turnCount
  );
}

// The review is spent per Goal, turn, and actionable revision: a resumed,
// re-scoped, or re-planned Goal earns a fresh one without any extra clearing.
const idleReviewKey = (goal) => `${goal.id}:${goal.turnCount}:${goal.revision}`;

// An automatic turn that called no tool answered its prompt without progress.
// Asking again over the same list only repeats that answer every few seconds
// until the deadline (a Goal with an unfinished row never reached the settled
// wait above), so the list waits for a change, the user, or its time boundary.
function automaticTurnWithoutActivity(detail, goal) {
  return (
    detail?.automatic === true &&
    detail.preserveGoalState !== true &&
    Number(detail.toolCalls) === 0 &&
    goal?.status === 'active'
  );
}

// Continuation prompts are enqueued as meta user messages, so a delivered rules
// block stays in the transcript until the context is compacted or rewound. The
// marker records which Goal's rules are already there: a new session or Goal, a
// reconciliation the rules must frame, or an explicit reset re-sends them.
function needsFullContinuationRules(markedGoalId, goal) {
  return markedGoalId !== goal.id || goal.needsTaskReview === true;
}

// A durable list drifts out of attention after roughly ten quiet turns — the
// staleness cadence task-reminder surfaces settle on across the industry — so
// the state block returns on that count rather than on an arbitrary period.
const GOAL_STATE_REMINDER_QUIET_TURNS = 10;

/** Fold a settled turn's outcome (usage limit, cancel, failure, or a clean
 *  finish) into the Goal status and clocks. */
function applyTurnOutcome(goal, detail, at) {
  const status = clean(typeof detail === 'string' ? detail : detail.status).toLowerCase();
  const usageLimited = detail?.usageLimited === true || detail?.usage_limited === true;
  if (usageLimited && ['active', 'duration_reached'].includes(goal.status)) {
    stopActiveClock(goal, at);
    clearTurnFailures(goal);
    goal.status = 'usage_limited';
    goal.blocker = clean(detail?.error) || 'Provider usage limit reached';
    return;
  }
  if (status === 'cancelled' && goal.status === 'active') {
    // Cancelling a turn stops that turn, not the objective: the stop control
    // is the only surface that retires a Goal. Record the cause so the next
    // user instruction decides whether the model resumes this work or leaves
    // it parked.
    stopActiveClock(goal, at);
    clearTurnFailures(goal);
    goal.status = 'paused';
    goal.pauseReason = 'cancelled';
    goal.blocker = '';
    return;
  }
  if (status === 'failed' && goal.status === 'active') {
    // A failed turn has exhausted its recovery. Starting another Goal turn
    // retries the same terminal error with a larger transcript. The model's
    // separate external-blocker audit still spans 3 turns.
    stopActiveClock(goal, at);
    goal.status = 'blocked';
    goal.failureReason = clean(detail?.error) || 'Goal turn failed';
    goal.failureCount = 1;
    goal.blocker = goal.failureReason;
    return;
  }
  clearTurnFailures(goal);
  if (goal.status !== 'active') return;
  checkpointActiveClock(goal, at);
  if (goal.timeLimitMs > 0 && goal.timeUsedMs >= goal.timeLimitMs) {
    stopActiveClock(goal, at);
    goal.status = 'duration_reached';
    goal.timeUsedMs = Math.max(goal.timeUsedMs, goal.timeLimitMs);
  }
}

export function createGoalTurnLifecycle(ctx) {
  const {
    now,
    turnGoalIds,
    turnStartedAt,
    idleReviewTurns,
    continuationTiers,
    withMutation,
    readRecord,
    commit,
    visibleSnapshot,
  } = ctx;
  return {
    startTurn(sessionId) {
      return withMutation(sessionId, async (id) => {
        const goal = readRecord(id).goal;
        // An archived Goal is retired work: it owns no turn bookkeeping, so
        // settleTurn can never hand the record back as live chrome.
        if (!goal || goal.archivedAt) {
          turnGoalIds.delete(id);
          turnStartedAt.delete(id);
          return null;
        }
        const at = now();
        turnGoalIds.set(id, goal.id);
        turnStartedAt.set(id, at);
        observeGoal(ctx, id, publicGoal(goal, at));
        if (goal.status !== 'active') return visibleSnapshot(id);
        goal.turnCount = Math.max(0, Math.floor(Number(goal.turnCount) || 0)) + 1;
        startActiveClock(goal, at);
        goal.updatedAt = at;
        const published = await commit(id, goal);
        // A turn that starts from the settled duration wait IS that review, so
        // the next continuation waits instead of asking again unchanged.
        if (settledDurationWait(published)) idleReviewTurns.set(id, idleReviewKey(published));
        else idleReviewTurns.delete(id);
        return published;
      });
    },
    settleTurn(sessionId, detail = {}) {
      return withMutation(sessionId, async (id) => {
        const expectedGoalId = turnGoalIds.get(id) || '';
        turnGoalIds.delete(id);
        turnStartedAt.delete(id);
        const goal = readRecord(id).goal;
        // commit() returns the record even when it is archived, so a settled
        // turn on retired work would republish the capsule the user's prompt
        // already dismissed.
        if (!goal || goal.archivedAt || (expectedGoalId && goal.id !== expectedGoalId)) return visibleSnapshot(id);
        const at = now();
        if (detail?.preserveGoalState === true) {
          if (goal.status === 'active') checkpointActiveClock(goal, at);
        } else {
          applyTurnOutcome(goal, detail, at);
        }
        goal.updatedAt = at;
        const published = await commit(id, goal);
        if (automaticTurnWithoutActivity(detail, published)) idleReviewTurns.set(id, idleReviewKey(published));
        return published;
      });
    },
    continuation(sessionId, { agentStatus = null } = {}) {
      const goal = visibleSnapshot(sessionId);
      if (goal?.status !== 'active') return { run: false, reason: goal?.status || 'missing', goal };
      if (runningAgentWork(agentStatus)) return { run: false, reason: 'agent-running', goal };
      const id = assertSessionId(sessionId);
      const answered = idleReviewTurns.get(id) === idleReviewKey(goal);
      if (settledDurationWait(goal)) {
        // The model already answered this exact list with no new work, so the
        // deadline timer owns the rest of the wait and delivers closeout;
        // task/scope changes still publish and wake newly actionable work.
        if (answered) return { run: false, reason: 'duration-wait', goal };
        // One turn to spend the remaining duration on new work or to park
        // approval-dependent work: idling it away is not the requested wait.
        // This turn has to decide the rest of the duration, so it carries the
        // full rules that decision is judged against.
        continuationTiers.set(id, { goalId: goal.id, revision: goal.revision, quietTurns: 0 });
        return { run: true, reason: 'idle-review', goal, prompt: continuationPrompt(goal, { idleReview: true }) };
      }
      // The same wait for an unfinished list: a task change, a user turn, or
      // the deadline's closeout starts the next Goal turn.
      if (answered) return { run: false, reason: 'no-progress-wait', goal };
      const entry = continuationTiers.get(id);
      if (needsFullContinuationRules(entry?.goalId, goal)) {
        continuationTiers.set(id, { goalId: goal.id, revision: goal.revision, quietTurns: 0 });
        return { run: true, reason: 'idle', goal, prompt: continuationPrompt(goal) };
      }
      // A changed revision means the model mutated tasks last turn and holds
      // the fresh list in its own tool result; repeating it buys nothing. The
      // state block returns only once the list has gone unread long enough to
      // drift out of attention.
      const quietTurns = entry.revision === goal.revision ? entry.quietTurns + 1 : 0;
      const includeState = quietTurns >= GOAL_STATE_REMINDER_QUIET_TURNS;
      continuationTiers.set(id, {
        goalId: goal.id,
        revision: goal.revision,
        quietTurns: includeState ? 0 : quietTurns,
      });
      return {
        run: true,
        reason: 'idle',
        goal,
        prompt: continuationPrompt(goal, { includeRules: false, includeState }),
      };
    },
    resetContinuationRules(sessionId) {
      continuationTiers.delete(assertSessionId(sessionId));
    },
    async archiveCompletedOnUserInput(sessionId) {
      if (!sessionId) return null;
      return withMutation(sessionId, async (id) => {
        const goal = readRecord(id).goal;
        // A model-abandoned Goal retires the same way a completed one does:
        // the user's next prompt is the acknowledgement that supersedes it.
        if (!goal || !goalFinished(goal) || goal.archivedAt) return visibleSnapshot(id);
        const at = now();
        goal.archivedAt = at;
        goal.updatedAt = at;
        await commit(id, goal);
        return null;
      });
    },
  };
}
