/**
 * goal-mutations.mjs — the durable Goal state transitions: create, the
 * model/user status update (complete / blocked) and abandon.
 * Each takes the shared runtime record (`ctx`) and commits through its store.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { compactSessionTitle } from './session-title.mjs';
import {
  GOAL_FILE_VERSION,
  NO_DEADLINE_WARNING_MS,
  assertSessionId,
  checkpointActiveClock,
  clearTurnFailures,
  parseGoalDuration,
  publicGoal,
  stopActiveClock,
  validateGoalBlocker,
  validateObjective,
} from './goal-state.mjs';
import { clean } from '../../../shared/clean.mjs';
import { writeJsonAtomicAsync } from '../../../shared/atomic-file.mjs';

const FINISHED_STATUSES = ['complete', 'stopped'];

/** A complete or stopped Goal: retired work that a successor may replace. */
export function goalFinished(goal) {
  return FINISHED_STATUSES.includes(goal.status);
}

/** A Goal that is neither running nor finished (paused, blocked, usage
 *  limited, time budget reached): it waits for the user, who may clear or
 *  replace it. */
export function goalStalled(goal) {
  return Boolean(goal) && goal.status !== 'active' && !goalFinished(goal);
}

/** Reject a write aimed at a Goal the caller no longer holds. */
export function assertExpectedGoal(goal, expectedGoalId, what = 'update') {
  if (clean(expectedGoalId) && clean(expectedGoalId) !== clean(goal.id)) {
    throw new Error(`stale Goal ${what} rejected because the active Goal changed`);
  }
}

// Explicit budget first, then a plain duration, then the configured default.
function initialTimeLimitMs(args, defaultTimeLimitMs) {
  if (args.timeLimitMs != null) return parseGoalDuration(args.timeLimitMs);
  if (args.duration) return parseGoalDuration(args.duration);
  const configured = Number(defaultTimeLimitMs);
  return Number.isFinite(configured) && configured > 0 ? parseGoalDuration(configured) : 0;
}

function newGoalRecord(id, args, at, defaultTimeLimitMs) {
  const startTurn = args.startInCurrentTurn === true ? 1 : 0;
  const timeLimitMs = initialTimeLimitMs(args, defaultTimeLimitMs);
  return {
    id: randomUUID(),
    sessionId: id,
    objective: validateObjective(args.objective),
    title: compactSessionTitle(args.objective),
    status: 'active',
    blocker: '',
    failureReason: '',
    failureCount: 0,
    turnCount: startTurn,
    timeLimitMs,
    timeUsedMs: 0,
    deadlineWarnedMs: NO_DEADLINE_WARNING_MS,
    warningRevision: 0,
    createdAt: at,
    updatedAt: at,
    lastStartedAt: at,
    completedAt: null,
    archivedAt: null,
  };
}

export function createGoalMutations(ctx) {
  const { root, now, defaultTimeLimitMs, turnGoalIds, turnStartedAt } = ctx;

  // The Goal owning the current turn keeps its open segment; any other stops.
  const settleActiveClock = (id, goal, at) => {
    if (turnGoalIds.get(id) === goal.id) checkpointActiveClock(goal, at);
    else stopActiveClock(goal, at);
  };

  // A finished Goal moves to the session's history before its successor takes
  // the live slot.
  const archiveFinishedGoal = async (id, goal) => {
    const write = ctx.writeGoalRecord || writeJsonAtomicAsync;
    await write(
      join(root, 'history', id, `${assertSessionId(goal.id)}.json`),
      { version: GOAL_FILE_VERSION, goal },
      { lock: true, secret: true, timeoutMs: 2_000 }
    );
  };

  const createGoal = async (sessionId, args = {}) => {
    const id = assertSessionId(sessionId);
    const record = ctx.readRecord(id);
    const replaced = goalStalled(record.goal) && args.replace === true;
    if (record.goal && !goalFinished(record.goal) && !replaced) {
      // Recovery is part of the message on purpose: without it a stopped Goal
      // (paused/blocked/limited) permanently blocked every later Goal in the
      // session, because the model owns no way to retire one.
      throw new Error(
        `cannot create a new Goal while an unfinished Goal exists (status ${record.goal.status}); ` +
          'finish it, or ask the user to stop it from the Goal controls'
      );
    }
    const at = now();
    const goal = newGoalRecord(id, args, at, defaultTimeLimitMs);
    if (args.startInCurrentTurn === true) {
      goal.lastStartedAt = record.goal ? at : turnStartedAt.get(id) || at;
    }
    if (replaced) {
      // The user confirmed: the stalled Goal retires into history as stopped.
      record.goal.status = 'stopped';
      record.goal.stoppedAt = at;
      record.goal.archivedAt = at;
      record.goal.updatedAt = at;
    }
    if (record.goal) await archiveFinishedGoal(id, record.goal);
    const created = await ctx.commit(id, goal);
    if (args.startInCurrentTurn === true) {
      turnGoalIds.set(id, goal.id);
      turnStartedAt.set(id, goal.lastStartedAt);
    }
    ctx.scheduleGoalTitle(id, goal);
    return created;
  };

  const updateGoal = async (sessionId, args = {}, { expectedGoalId = '' } = {}) => {
    const id = assertSessionId(sessionId);
    const goal = ctx.requireGoal(id);
    assertExpectedGoal(goal, expectedGoalId, 'update');
    const at = now();
    const status = clean(args.status).toLowerCase();
    if (goal.status === 'stopped') throw new Error('a stopped Goal cannot resume or complete; create a new Goal');
    if (!status) throw new Error('goal status is required');
    if (!['complete', 'blocked'].includes(status)) {
      throw new Error('goal can only set status complete or blocked');
    }
    if (goal.status === 'complete') {
      if (status === 'complete') return publicGoal(goal, at);
      throw new Error('a completed Goal cannot change status; edit it or create a new Goal');
    }
    if (status === 'complete') {
      // Completion is the model's claim after its own evidence audit (or
      // the user's act of authority); the runtime never completes by itself.
      settleActiveClock(id, goal, at);
      goal.status = 'complete';
      goal.completedAt = at;
      goal.blocker = '';
      clearTurnFailures(goal);
    } else {
      const blocker = validateGoalBlocker(args.blocker);
      settleActiveClock(id, goal, at);
      goal.status = 'blocked';
      goal.blocker = blocker;
      clearTurnFailures(goal);
    }
    goal.updatedAt = at;
    return ctx.commit(id, goal);
  };

  // Explicit retirement of a superseded Goal. The create guard stays strict so
  // parallel Goals stay impossible; this is the one way out of it, and it is
  // deliberately an act the model has to take rather than a silent overwrite.
  const abandonGoal = async (sessionId, { expectedGoalId = '', archive = false } = {}) => {
    const id = assertSessionId(sessionId);
    const goal = ctx.requireGoal(id);
    assertExpectedGoal(goal, expectedGoalId, 'abandon');
    const at = now();
    stopActiveClock(goal, at);
    goal.status = 'stopped';
    goal.stoppedAt = at;
    goal.updatedAt = at;
    goal.blocker = '';
    // A stopped Goal can neither resume nor be edited, so a user who confirmed
    // the stop has nothing left to do with its chrome: retire it at once. The
    // record stays for history so the unfinished work is still preserved.
    if (archive) goal.archivedAt = goal.stoppedAt;
    await ctx.commit(id, goal);
    turnGoalIds.delete(id);
    return publicGoal(goal, now());
  };

  return { createGoal, updateGoal, abandonGoal };
}
