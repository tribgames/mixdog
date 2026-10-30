/**
 * goal-turns.mjs — the Goal's turn lifecycle: opening a turn on the active
 * clock, settling it from the turn outcome, deciding whether an idle session
 * should continue, and retiring finished work on the next user prompt.
 */
import { continuationPrompt } from './goal-text.mjs';
import {
  assertSessionId,
  checkpointActiveClock,
  clearTurnFailures,
  resumeGoalState,
  startActiveClock,
  stopActiveClock,
} from './goal-state.mjs';
import { goalFinished } from './goal-mutations.mjs';
import { awaitingBackgroundWork } from '../../../shared/background-wait.mjs';
import { clean } from '../../../shared/clean.mjs';

// The no-progress wait is spent per Goal and turn: the next user turn (or a
// resume, which starts a new turn) earns a fresh continuation.
const idleReviewKey = (goal) => `${goal.id}:${goal.turnCount}`;

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
// marker records which Goal's rules are already there: a new session or Goal,
// or an explicit reset (compaction, objective edit) re-sends them.

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
    // retries the same terminal error with a larger transcript.
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
    goal.timeUsedMs = goal.timeLimitMs;
  }
}

export function createGoalTurnLifecycle(ctx) {
  const {
    now,
    turnGoalIds,
    turnStartedAt,
    idleReviewTurns,
    continuationTiers,
    unsavedStops,
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
        if (goal.status !== 'active') return visibleSnapshot(id);
        goal.turnCount = Math.max(0, Math.floor(Number(goal.turnCount) || 0)) + 1;
        startActiveClock(goal, at);
        goal.updatedAt = at;
        idleReviewTurns.delete(id);
        return commit(id, goal);
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
        let published;
        try {
          published = await commit(id, goal);
        } catch (error) {
          if (goal.status !== 'active') unsavedStops.set(id, goal.id);
          throw error;
        }
        unsavedStops.delete(id);
        if (automaticTurnWithoutActivity(detail, published)) idleReviewTurns.set(id, idleReviewKey(published));
        return published;
      });
    },
    // A quota resume revives exactly the Goal its failure suspended, and only
    // while that Goal is still waiting on the limit: a Goal the user paused,
    // stopped, replaced or completed meanwhile stays as it is.
    reactivateUsageLimited(sessionId, goalId, options = {}) {
      return withMutation(sessionId, async (id) => {
        if (options.isCurrent && !options.isCurrent()) return null;
        const goal = readRecord(id).goal;
        if (!goal || goal.archivedAt || goal.id !== clean(goalId) || goal.status !== 'usage_limited') return null;
        try {
          resumeGoalState(goal, now());
        } catch {
          return null;
        }
        return commit(id, goal, options);
      });
    },
    // `todo`: the session's open step list, carried in every continuation.
    continuation(sessionId, { agentStatus = null, todo = '' } = {}) {
      const goal = visibleSnapshot(sessionId);
      if (goal?.status !== 'active') return { run: false, reason: goal?.status || 'missing', goal };
      const id = assertSessionId(sessionId);
      // The same wait rule as the todo completion check: a running agent or
      // an awaited background shell wakes the session when it ends.
      if (awaitingBackgroundWork({ sessionId: id, agentStatus })) return { run: false, reason: 'awaiting-work', goal };
      if (unsavedStops.get(id) === goal.id) return { run: false, reason: 'unsaved-stop', goal };
      // An automatic turn already answered with no tool call: a user turn or
      // the deadline's closeout starts the next Goal turn.
      if (idleReviewTurns.get(id) === idleReviewKey(goal)) return { run: false, reason: 'no-progress-wait', goal };
      const includeRules = continuationTiers.get(id) !== goal.id;
      continuationTiers.set(id, goal.id);
      return { run: true, reason: 'idle', goal, prompt: continuationPrompt(goal, { includeRules, todo }) };
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
