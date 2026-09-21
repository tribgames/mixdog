/**
 * goal-mutations.mjs — the durable Goal state transitions: create, the
 * model/user status update (complete / blocked), task edits and abandon.
 * Each takes the shared runtime record (`ctx`) and commits through its store.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { compactSessionTitle } from './session-title.mjs';
import { GOAL_TASK_SETTLED } from './goal-tool-defs.mjs';
import { applyGoalTaskChanges, goalTasksStartWork, normalizeGoalTasks } from './goal-tasks.mjs';
import {
  GOAL_FILE_VERSION,
  NO_DEADLINE_WARNING_MS,
  activeElapsedMs,
  assertSessionId,
  checkpointActiveClock,
  clearTurnFailures,
  goalTimeMode,
  parseGoalDuration,
  publicGoal,
  resumeGoalState,
  stopActiveClock,
  validateGoalBlocker,
  validateObjective,
} from './goal-state.mjs';
import { clean } from '../runtime/shared/clean.mjs';
import { writeJsonAtomicAsync } from '../runtime/shared/atomic-file.mjs';

const FINISHED_STATUSES = ['complete', 'stopped'];

/** A complete or stopped Goal: retired work that a successor may replace. */
export function goalFinished(goal) {
  return FINISHED_STATUSES.includes(goal.status);
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
  const initialTasks = Array.isArray(args.tasks)
    ? normalizeGoalTasks(
        args.tasks.filter((task) => clean(task?.text)),
        [],
        { strict: true }
      )
    : [];
  return {
    id: randomUUID(),
    revision: 1,
    objectiveRevision: 1,
    tasksObjectiveRevision: 1,
    sessionId: id,
    objective: validateObjective(args.objective),
    title: compactSessionTitle(args.objective),
    status: 'active',
    tasks: initialTasks,
    blocker: '',
    failureReason: '',
    failureCount: 0,
    turnCount: startTurn,
    lastDropTurn: initialTasks.some((task) => task.status === 'dropped') ? startTurn : -1,
    tasksUpdatedAt: initialTasks.length > 0 ? at : null,
    timeLimitMs: initialTimeLimitMs(args, defaultTimeLimitMs),
    timeMode: goalTimeMode(args.timeMode),
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

// Evidence gates the MODEL's completion claim, never the user's. A user
// completing their own Goal is an act of authority: without this the only
// user-side exit was deleting the Goal, which threw the record away.
// Unfinished rows stay unfinished so the record stays honest.
function assertCompletionEvidence(goal, at) {
  if (goal.tasksObjectiveRevision !== goal.objectiveRevision) {
    throw new Error(
      'cannot complete Goal: objective changed; read goal status and reconcile the full task list with set_tasks first'
    );
  }
  const tasks = normalizeGoalTasks(goal.tasks || []);
  const incomplete = tasks.filter((task) => !GOAL_TASK_SETTLED.includes(task.status));
  if (incomplete.length > 0) {
    throw new Error(`cannot complete Goal: ${incomplete.length} durable tasks remain incomplete`);
  }
  const turnCount = Math.max(0, Math.floor(Number(goal.turnCount) || 0));
  if (goal.lastDropTurn >= 0 && goal.lastDropTurn === turnCount) {
    throw new Error(
      'cannot complete Goal: a task was dropped this turn; only a user scope change retires ' +
        'requested work, so finish that work or let the user confirm the change first'
    );
  }
  if (goal.timeMode === 'duration' && goal.timeLimitMs > 0 && activeElapsedMs(goal, at) < goal.timeLimitMs) {
    throw new Error(
      'cannot complete Goal before the requested duration ends; keep working, or the user may explicitly complete the Goal'
    );
  }
}

// Three consecutive turns naming the same blocker confirm it; true once the
// audit reaches that count.
function recordBlockAudit(goal, blocker) {
  const turn = goal.turnCount;
  const previous = goal.blockAudit;
  const sameBlocker = previous?.reason === blocker;
  let count = 1;
  if (sameBlocker && previous.turn === turn) count = previous.count;
  else if (sameBlocker && previous.turn === turn - 1) count = previous.count + 1;
  goal.blockAudit = { reason: blocker, turn, count };
  return count >= 3;
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
      { lock: true, secret: true, fsync: false, timeoutMs: 2_000 }
    );
  };

  const createGoal = async (sessionId, args = {}) => {
    const id = assertSessionId(sessionId);
    const record = ctx.readRecord(id);
    if (record.goal && !goalFinished(record.goal)) {
      // Recovery is part of the message on purpose: without it a stopped Goal
      // (paused/blocked/limited) permanently blocked every later Goal in the
      // session, because the model owns no way to retire one.
      throw new Error(
        `cannot create a new Goal while an unfinished Goal exists (status ${record.goal.status}); ` +
          'resume and finish it, or abandon it if the user redirected away from that objective'
      );
    }
    const at = now();
    const goal = newGoalRecord(id, args, at, defaultTimeLimitMs);
    if (args.startInCurrentTurn === true) {
      goal.lastStartedAt = record.goal ? at : turnStartedAt.get(id) || at;
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

  const updateGoal = async (sessionId, args = {}, { user = false, expectedGoalId = '' } = {}) => {
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
      if (!user) assertCompletionEvidence(goal, at);
      settleActiveClock(id, goal, at);
      goal.status = 'complete';
      goal.completedAt = at;
      goal.blocker = '';
      clearTurnFailures(goal);
    } else {
      const blocker = validateGoalBlocker(args.blocker);
      if (!recordBlockAudit(goal, blocker)) {
        goal.updatedAt = at;
        return ctx.commit(id, goal);
      }
      settleActiveClock(id, goal, at);
      goal.status = 'blocked';
      goal.blocker = blocker;
      clearTurnFailures(goal);
    }
    goal.updatedAt = at;
    return ctx.commit(id, goal);
  };

  const setGoalTasks = async (sessionId, args = {}, { expectedGoalId = '', partial = false } = {}) => {
    const id = assertSessionId(sessionId);
    const goal = ctx.requireGoal(id);
    assertExpectedGoal(goal, expectedGoalId, 'task update');
    const at = now();
    const previousTasks = goal.tasks;
    applyGoalTaskChanges(goal, args, { partial, at });
    if (
      goal.status === 'paused' &&
      goal.pauseReason === 'waiting' &&
      goalTasksStartWork(previousTasks, goal.tasks, args, { partial })
    ) {
      // Starting approved work and resuming its Goal are one durable write.
      // Intake, status reads, and bookkeeping alone never grant approval.
      resumeGoalState(goal, at);
    }
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

  return { createGoal, updateGoal, setGoalTasks, abandonGoal };
}
