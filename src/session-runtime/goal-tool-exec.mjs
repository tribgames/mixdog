/**
 * goal-tool-exec.mjs — the model-facing `goal` tool: optimistic-concurrency
 * bookkeeping (the revision the model last observed) and one handler per
 * tool action, each replying with the compact or full Goal view.
 */
import { GOAL_TASK_SETTLED, validateGoalToolCall } from './goal-tool-defs.mjs';
import { assertSessionId, parseGoalDuration } from './goal-state.mjs';
import { goalFinished } from './goal-mutations.mjs';

export function observeGoal(ctx, id, goal) {
  if (goal) ctx.observedGoals.set(id, { id: goal.id, revision: goal.revision });
  else ctx.observedGoals.delete(id);
}

function toolReply(ctx, id, goal, { full = false, previousIds = null } = {}) {
  observeGoal(ctx, id, goal);
  let goalView = goal;
  if (goal && !full) {
    goalView = {
      id: goal.id,
      revision: goal.revision,
      status: goal.status,
      tasksCompleted: goal.tasksCompleted,
      tasksTotal: goal.tasksTotal,
      tasksUpdatedAt: goal.tasksUpdatedAt,
      timeUsedMs: goal.timeUsedMs,
    };
    if (goal.blocker) goalView.blocker = goal.blocker;
    if (goal.blockAudit) goalView.blockAudit = goal.blockAudit;
    if (goal.needsTaskReview) goalView.needsTaskReview = true;
  }
  const result = { goal: goalView, remaining_ms: goal?.remainingMs ?? null };
  if (!full && previousIds && goal) {
    const added = goal.tasks.filter((task) => !previousIds.has(task.id));
    if (added.length) result.assigned_tasks = added.map(({ id: taskId, text }) => ({ id: taskId, text }));
  }
  return JSON.stringify(result);
}

function mutateObserved(ctx, id, args, operation) {
  const current = ctx.requireGoal(id);
  const expectedGoalId = ctx.turnGoalIds.get(id) || current.id;
  const observed = ctx.observedGoals.get(id);
  // Capture BEFORE queueing: two concurrent calls based on one snapshot must
  // not both overwrite it. Old frozen schemas use the last tool result.
  let expectedRevision = current.revision;
  if (args.revision != null && args.revision !== '') expectedRevision = args.revision;
  else if (observed?.id === expectedGoalId) expectedRevision = observed.revision;
  return ctx.withMutation(id, () => {
    const latest = ctx.requireGoal(id);
    if (latest.id !== expectedGoalId) throw new Error('stale Goal update rejected because the active Goal changed');
    if (latest.revision !== expectedRevision)
      throw new Error(
        `stale Goal revision: expected ${expectedRevision}, current ${latest.revision}; read goal status and reconcile before retrying`
      );
    return operation(expectedGoalId);
  });
}

/** create/resume budget in ms, or undefined when the call carries none. */
function toolTimeLimitMs(args) {
  if (args.time_limit_minutes == null || args.time_limit_minutes === '') return undefined;
  const minutes = Number(args.time_limit_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('goal time_limit_minutes must be a positive number');
  }
  return parseGoalDuration(minutes * 60_000);
}

async function pauseOrResume(ctx, id, args, action) {
  const timeLimitMs = action === 'resume' ? toolTimeLimitMs(args) : undefined;
  const result = await mutateObserved(ctx, id, args, (expectedGoalId) => {
    const current = ctx.requireGoal(id);
    if (goalFinished(current)) {
      throw new Error(`a ${current.status === 'complete' ? 'completed' : 'stopped'} Goal cannot be paused or resumed`);
    }
    if (action === 'pause') {
      const remaining = current.tasks.filter((task) => !GOAL_TASK_SETTLED.includes(task.status));
      if (!remaining.length || remaining.some((task) => task.status !== 'awaiting_approval')) {
        throw new Error(
          'cannot pause Goal: continue available work; park every user-dependent remaining task as awaiting_approval first'
        );
      }
    }
    const change =
      action === 'resume'
        ? { updates: args.updates, tasks: args.tasks, duration: timeLimitMs, timeMode: args.time_mode }
        : { pauseReason: 'waiting', blocker: args.blocker };
    return ctx.control(id, { action, expectedGoalId, ...change });
  });
  return toolReply(ctx, id, result.goal, { full: action === 'resume' });
}

async function editTasks(ctx, id, args, action) {
  let previousIds;
  const goal = await mutateObserved(ctx, id, args, (expectedGoalId) => {
    previousIds = new Set(ctx.requireGoal(id).tasks.map((task) => task.id));
    return ctx.setGoalTasks(id, args, { expectedGoalId, partial: action === 'update_tasks' });
  });
  return toolReply(ctx, id, goal, { previousIds });
}

async function settleStatus(ctx, id, args, action) {
  const goal = await mutateObserved(ctx, id, args, (expectedGoalId) =>
    ctx.updateGoal(
      id,
      {
        status: action === 'block' ? 'blocked' : 'complete',
        ...(action === 'block' ? { blocker: args.blocker } : {}),
      },
      { expectedGoalId }
    )
  );
  return toolReply(ctx, id, goal);
}

const GOAL_TOOL_ACTIONS = {
  status(ctx, id) {
    // Same view the user sees. Reading the stored record here showed the
    // model Goals the user had already archived away.
    ctx.readRecord(id); // Corruption is an actionable error, not "no Goal".
    return toolReply(ctx, id, ctx.visibleSnapshot(id), { full: true });
  },
  async create(ctx, id, args) {
    const timeLimitMs = toolTimeLimitMs(args);
    const goal = await ctx.withMutation(id, () =>
      ctx.createGoal(id, {
        objective: args.objective,
        tasks: args.tasks,
        startInCurrentTurn: true,
        ...(timeLimitMs != null ? { timeLimitMs } : {}),
        timeMode: args.time_mode,
      })
    );
    return toolReply(ctx, id, goal, { full: true });
  },
  async abandon(ctx, id, args) {
    const goal = await mutateObserved(ctx, id, args, (expectedGoalId) => ctx.abandonGoal(id, { expectedGoalId }));
    return toolReply(ctx, id, goal);
  },
  pause: pauseOrResume,
  resume: pauseOrResume,
  set_tasks: editTasks,
  update_tasks: editTasks,
  block: settleStatus,
  complete: settleStatus,
};

export async function executeGoalTool(ctx, name, args = {}, context = {}) {
  const sessionId = context.callerSessionId || context.sessionId;
  const id = assertSessionId(sessionId);
  if (name !== 'goal') throw new Error(`unknown Goal tool: ${name}`);
  const action = validateGoalToolCall(args);
  const handler = GOAL_TOOL_ACTIONS[action];
  return handler(ctx, id, args, action);
}
