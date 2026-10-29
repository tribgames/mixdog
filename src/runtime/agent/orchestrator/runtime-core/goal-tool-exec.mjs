/**
 * goal-tool-exec.mjs — the model-facing `goal` tool: status, create, and the
 * model's two settlements (complete after its evidence audit, block on an
 * impasse), each replying with the compact or full Goal view.
 */
import { validateGoalToolCall } from './goal-tool-defs.mjs';
import { assertSessionId, parseGoalDuration } from './goal-state.mjs';

function toolReply(goal, { full = false } = {}) {
  let goalView = goal;
  if (goal && !full) {
    goalView = { id: goal.id, status: goal.status, timeUsedMs: goal.timeUsedMs };
    if (goal.blocker) goalView.blocker = goal.blocker;
  }
  return JSON.stringify({ goal: goalView, remaining_ms: goal?.remainingMs ?? null });
}

/** create budget in ms, or undefined when the call carries none. */
function toolTimeLimitMs(args) {
  if (args.time_limit_minutes == null || args.time_limit_minutes === '') return undefined;
  const minutes = Number(args.time_limit_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('goal time_limit_minutes must be a positive number');
  }
  return parseGoalDuration(minutes * 60_000);
}

// A settlement applies to the Goal this turn worked on: one replaced
// meanwhile is refused instead of settled by mistake.
async function settleStatus(ctx, id, args, action) {
  const expectedGoalId = ctx.turnGoalIds.get(id) || ctx.requireGoal(id).id;
  const goal = await ctx.withMutation(id, () =>
    ctx.updateGoal(
      id,
      { status: action === 'block' ? 'blocked' : 'complete', ...(action === 'block' ? { blocker: args.blocker } : {}) },
      { expectedGoalId }
    )
  );
  return toolReply(goal);
}

const GOAL_TOOL_ACTIONS = {
  status(ctx, id) {
    // Same view the user sees. Reading the stored record here showed the
    // model Goals the user had already archived away.
    ctx.readRecord(id); // A real I/O error is an actionable error, not "no Goal".
    return toolReply(ctx.visibleSnapshot(id), { full: true });
  },
  async create(ctx, id, args) {
    const timeLimitMs = toolTimeLimitMs(args);
    const goal = await ctx.withMutation(id, () =>
      ctx.createGoal(id, {
        objective: args.objective,
        startInCurrentTurn: true,
        ...(timeLimitMs != null ? { timeLimitMs } : {}),
      })
    );
    return toolReply(goal, { full: true });
  },
  block: settleStatus,
  complete: settleStatus,
};

export async function executeGoalTool(ctx, name, args = {}, context = {}) {
  const sessionId = context.callerSessionId || context.sessionId;
  const id = assertSessionId(sessionId);
  if (name !== 'goal') throw new Error(`unknown Goal tool: ${name}`);
  const action = validateGoalToolCall(args);
  return GOAL_TOOL_ACTIONS[action](ctx, id, args, action);
}
