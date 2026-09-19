/**
 * goal-control.mjs — the user-facing Goal control surface (slash command /
 * desktop chrome): parses the request, applies the shared freshness checks and
 * dispatches to one handler per action.
 */
import { durationLabel } from './goal-text.mjs';
import { compactSessionTitle } from './session-title.mjs';
import { applyGoalTaskChanges, optionalGoalTaskChanges } from './goal-tasks.mjs';
import {
  NO_DEADLINE_WARNING_MS,
  activateGoal,
  activeElapsedMs,
  assertSessionId,
  clearTurnFailures,
  goalTimeMode,
  parseGoalDuration,
  parseUserCommand,
  resumeGoalState,
  stopActiveClock,
  validateGoalBlocker,
  validateObjective,
} from './goal-state.mjs';
import { assertExpectedGoal } from './goal-mutations.mjs';
import { clean } from '../runtime/shared/clean.mjs';

/** "12m remaining" for a budgeted Goal, "3m elapsed" for an open-ended one. */
export function goalTimingLabel(goal) {
  return Number(goal.timeLimitMs) > 0
    ? `${durationLabel(goal.remainingMs)} remaining`
    : `${durationLabel(goal.timeUsedMs)} elapsed`;
}

const reply = (action, goal, message) => ({ ok: true, action, goal, message });

const GOAL_CONTROL_ACTIONS = {
  async stop(ctx, { id, expectedGoalId, action }) {
    const goal = await ctx.abandonGoal(id, { expectedGoalId, archive: true });
    return reply(action, goal, `Goal stopped · ${goal.objective}`);
  },
  async pause(ctx, { id, goal, args, at, action }) {
    if (goal.status === 'complete') throw new Error('a completed Goal cannot be paused; edit it or create a new Goal');
    if (goal.status === 'active') stopActiveClock(goal, at);
    goal.status = 'paused';
    goal.pauseReason = args.pauseReason === 'waiting' ? 'waiting' : 'user';
    goal.blocker = args.pauseReason === 'waiting' ? validateGoalBlocker(args.blocker) : '';
    clearTurnFailures(goal);
    goal.updatedAt = at;
    const paused = await ctx.commit(id, goal);
    return reply(action, paused, `Goal paused · ${paused.objective}`);
  },
  async resume(ctx, { id, goal, args, at, action }) {
    if (goal.status === 'complete') {
      throw new Error('a completed Goal cannot be resumed; edit it or create a new Goal');
    }
    const added = args.duration ? parseGoalDuration(args.duration) : null;
    const timeMode = goalTimeMode(args.timeMode, goal.timeMode);
    // Empty optional fields from frozen provider schemas still mean a plain
    // resume. Supplied changes validate before activation and share its write.
    const taskChanges = optionalGoalTaskChanges(args);
    const hasTaskChanges = [taskChanges.updates, taskChanges.tasks].some(
      (value) => value != null && (!Array.isArray(value) || value.length > 0)
    );
    if (hasTaskChanges) applyGoalTaskChanges(goal, taskChanges, { partial: true, at });
    resumeGoalState(goal, at, added);
    goal.timeMode = timeMode;
    const resumed = await ctx.commit(id, goal);
    return reply(action, resumed, `Goal resumed · ${resumed.objective} · ${goalTimingLabel(resumed)}`);
  },
  async edit(ctx, { id, goal, args, at, action }) {
    // Tasks survive an objective edit. The desktop "Edit goal" button drafts
    // the CURRENT objective, so wiping the list meant refining one word threw
    // away every completed row; re-aligning a stale list is set_tasks' job.
    const objective = validateObjective(args.objective);
    let timeLimitMs = goal.timeLimitMs;
    if (args.timeLimitMs != null) timeLimitMs = args.timeLimitMs === 0 ? 0 : parseGoalDuration(args.timeLimitMs);
    else if (args.duration != null) timeLimitMs = parseGoalDuration(args.duration);
    const timeMode = goalTimeMode(args.timeMode, goal.timeMode);
    if (objective !== goal.objective) goal.objectiveRevision += 1;
    goal.objective = objective;
    goal.title = compactSessionTitle(goal.objective);
    if (timeLimitMs !== goal.timeLimitMs) goal.deadlineWarnedMs = NO_DEADLINE_WARNING_MS;
    goal.timeLimitMs = timeLimitMs;
    goal.timeMode = timeMode;
    if (goal.status === 'complete') activateGoal(goal, at);
    else clearTurnFailures(goal);
    goal.updatedAt = at;
    const updated = await ctx.commit(id, goal);
    ctx.scheduleGoalTitle(id, updated);
    return reply(action, updated, `Goal updated · ${updated.objective}`);
  },
  async time(ctx, { id, goal, args, at, action }) {
    const limit = parseGoalDuration(args.duration);
    const used = activeElapsedMs(goal, at);
    goal.timeLimitMs = limit;
    // A new commitment re-earns its warnings.
    goal.deadlineWarnedMs = NO_DEADLINE_WARNING_MS;
    if (goal.status === 'active') {
      goal.timeUsedMs = used;
      goal.lastStartedAt = at;
      if (used >= limit) {
        stopActiveClock(goal, at);
        goal.status = 'duration_reached';
      }
    }
    goal.updatedAt = at;
    const timed = await ctx.commit(id, goal);
    return reply(action, timed, `Goal duration · ${durationLabel(limit)}`);
  },
  async complete(ctx, { id, action }) {
    const goal = await ctx.updateGoal(id, { status: 'complete' }, { user: true });
    return reply(action, goal, `Goal complete · ${goal.objective} · ${durationLabel(goal.timeUsedMs)} elapsed`);
  },
};

export async function runGoalControl(ctx, sessionId, rawArgs = {}) {
  const id = assertSessionId(sessionId);
  let args = rawArgs;
  if (typeof rawArgs === 'string') args = parseUserCommand(rawArgs);
  else if (rawArgs?.command != null) args = { ...rawArgs, ...parseUserCommand(rawArgs.command) };
  const action = clean(args?.action || 'get').toLowerCase();
  if (action === 'create') {
    const goal = await ctx.createGoal(id, {
      objective: args.objective,
      duration: args.duration,
      timeLimitMs: args.timeLimitMs,
      timeMode: args.timeMode,
    });
    return reply(action, goal, `Goal active · ${goal.objective} · ${goalTimingLabel(goal)}`);
  }
  if (action === 'get' || action === 'status') {
    const goal = ctx.visibleSnapshot(id);
    let message = 'No visible Goal for this session';
    if (goal) {
      const timing = goal.status === 'active' ? ` · ${goalTimingLabel(goal)}` : '';
      message = `Goal ${goal.status} · ${goal.objective}${timing}`;
    }
    return reply('get', goal, message);
  }
  if (action === 'clear') {
    await ctx.commit(id, null);
    return reply(action, null, 'Goal cleared');
  }
  const goal = ctx.requireGoal(id);
  const expectedGoalId = clean(args.expectedGoalId);
  assertExpectedGoal(goal, expectedGoalId, 'update');
  if (args.revision != null && args.revision !== goal.revision) {
    throw new Error('Goal changed while editing; reopen the editor before saving');
  }
  const at = ctx.now();
  if (goal.status === 'stopped') throw new Error('a stopped Goal cannot be changed; create a new Goal');
  const handler = GOAL_CONTROL_ACTIONS[action];
  if (!handler) throw new Error(`unknown Goal action: ${action}`);
  return handler(ctx, { id, goal, args, at, expectedGoalId, action });
}
