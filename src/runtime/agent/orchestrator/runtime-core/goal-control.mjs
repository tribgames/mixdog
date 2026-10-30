/**
 * goal-control.mjs — the user-facing Goal control surface (slash command /
 * desktop chrome): parses the request, applies the shared freshness checks and
 * dispatches to one handler per action.
 */
import { durationLabel } from './goal-text.mjs';
import { compactSessionTitle } from './session-title.mjs';
import {
  NO_DEADLINE_WARNING_MS,
  activateGoal,
  activeElapsedMs,
  assertSessionId,
  clearTurnFailures,
  parseGoalDuration,
  parseUserCommand,
  resumeGoalState,
  stopActiveClock,
  validateObjective,
} from './goal-state.mjs';
import { assertExpectedGoal, goalFinished } from './goal-mutations.mjs';
import { clean } from '../../../shared/clean.mjs';

/** "12m remaining" for a budgeted Goal, "3m elapsed" for an open-ended one. */
function goalTimingLabel(goal) {
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
  async pause(ctx, { id, goal, at, action }) {
    if (goal.status === 'complete') throw new Error('a completed Goal cannot be paused; edit it or create a new Goal');
    if (goal.status === 'active') stopActiveClock(goal, at);
    goal.status = 'paused';
    goal.pauseReason = 'user';
    goal.blocker = '';
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
    resumeGoalState(goal, at, added);
    const resumed = await ctx.commit(id, goal);
    return reply(action, resumed, `Goal resumed · ${resumed.objective} · ${goalTimingLabel(resumed)}`);
  },
  async edit(ctx, { id, goal, args, at, action }) {
    // The session's todo list is untouched by an objective edit; the
    // objective-updated reminder asks the model to re-align it.
    const objective = validateObjective(args.objective);
    let timeLimitMs = goal.timeLimitMs;
    if (args.time_limit_minutes != null && args.time_limit_minutes !== '') {
      const minutes = Number(args.time_limit_minutes);
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error('goal time_limit_minutes must be 0 or more');
      timeLimitMs = minutes === 0 ? 0 : parseGoalDuration(minutes * 60_000);
    } else if (args.timeLimitMs != null) {
      timeLimitMs = args.timeLimitMs === 0 ? 0 : parseGoalDuration(args.timeLimitMs);
    } else if (args.duration != null) timeLimitMs = parseGoalDuration(args.duration);
    goal.objective = objective;
    goal.title = compactSessionTitle(goal.objective);
    if (timeLimitMs !== goal.timeLimitMs) goal.deadlineWarnedMs = NO_DEADLINE_WARNING_MS;
    goal.timeLimitMs = timeLimitMs;
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
    const goal = await ctx.updateGoal(id, { status: 'complete' });
    return reply(action, goal, `Goal complete · ${goal.objective} · ${durationLabel(goal.timeUsedMs)} elapsed`);
  },
  async dismiss(ctx, { id, goal, at, action }) {
    // The user's acknowledgement of finished work: the same archive a new
    // prompt applies, so the chrome lets go while the record stays.
    if (!goalFinished(goal)) throw new Error('only a finished Goal can be dismissed; stop or complete it first');
    if (!goal.archivedAt) {
      goal.archivedAt = at;
      goal.updatedAt = at;
      await ctx.commit(id, goal);
    }
    return reply(action, null, `Goal dismissed · ${goal.objective}`);
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
  const at = ctx.now();
  if (goal.status === 'stopped' && action !== 'dismiss') {
    throw new Error('a stopped Goal cannot be changed; create a new Goal');
  }
  const handler = GOAL_CONTROL_ACTIONS[action];
  if (!handler) throw new Error(`unknown Goal action: ${action}`);
  return handler(ctx, { id, goal, args, at, expectedGoalId, action });
}
