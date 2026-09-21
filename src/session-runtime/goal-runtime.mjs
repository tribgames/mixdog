/**
 * goal-runtime.mjs — assembles the Goal runtime from its parts around one
 * explicit runtime record (`ctx`): configuration and per-session bookkeeping
 * first, then the store, deadlines, title scheduler, mutations and the
 * control surface, each reading the earlier stages through `ctx`.
 */
import { join } from 'node:path';

import { GOAL_TOOL_DEFS, MAX_GOAL_TIME_LIMIT_MS } from './goal-tool-defs.mjs';
import { reportGoalStorageError } from './goal-storage.mjs';
import { createGoalDeadlines } from './goal-deadlines.mjs';
import {
  DEFAULT_COMPLETED_GOAL_TTL_MS,
  DEFAULT_GOAL_DEADLINE_WARNING_MS,
  DEFAULT_GOAL_TIME_LIMIT_MS,
  normalizedCompletedGoalTtlMs,
  parseGoalDuration,
} from './goal-state.mjs';
import { createGoalStore } from './goal-store.mjs';
import { createGoalTitleScheduler } from './goal-title.mjs';
import { createGoalMutations } from './goal-mutations.mjs';
import { runGoalControl } from './goal-control.mjs';
import { executeGoalTool } from './goal-tool-exec.mjs';
import { createGoalTurnLifecycle } from './goal-turns.mjs';
import { clean } from '../runtime/shared/clean.mjs';

export {
  DEFAULT_COMPLETED_GOAL_TTL_MS,
  DEFAULT_GOAL_DEADLINE_WARNING_MS,
  DEFAULT_GOAL_TIME_LIMIT_MS,
  GOAL_TOOL_DEFS,
  MAX_GOAL_TIME_LIMIT_MS,
  parseGoalDuration,
};
export { GOAL_STATUS_VALUES } from './goal-state.mjs';
export { listStoredActiveGoalSessionIds, readStoredGoalSnapshot } from './goal-storage.mjs';

export function createGoalRuntime({
  dataDir,
  now = () => Date.now(),
  defaultTimeLimitMs = DEFAULT_GOAL_TIME_LIMIT_MS,
  completedGoalTtlMs = DEFAULT_COMPLETED_GOAL_TTL_MS,
  deadlineWarningMs = DEFAULT_GOAL_DEADLINE_WARNING_MS,
  generateTitle = null,
  writeGoalRecord,
  onStorageError = reportGoalStorageError,
} = {}) {
  const ctx = {
    dataDir,
    root: join(clean(dataDir) || process.cwd(), 'goals'),
    now,
    defaultTimeLimitMs,
    completedRetentionMs: normalizedCompletedGoalTtlMs(completedGoalTtlMs),
    generateTitle,
    writeGoalRecord,
    onStorageError,
    listeners: new Set(),
    mutationChains: new Map(),
    turnGoalIds: new Map(),
    turnStartedAt: new Map(),
    titleJobs: new Map(),
    observedGoals: new Map(),
    // Session -> the Goal identity, turn, and revision that already spent its
    // one settled-duration review. In memory on purpose: a restart is a new
    // chance.
    idleReviewTurns: new Map(),
    // Session -> { goalId, revision, quietTurns }: which continuation tier this
    // context still owes, from the rules and state already delivered into it.
    // In memory on purpose: a restart is a fresh context that needs them again.
    continuationTiers: new Map(),
    closed: false,
  };
  Object.assign(ctx, createGoalStore(ctx));
  ctx.deadlines = createGoalDeadlines({
    now,
    readRecord: ctx.readRecord,
    withMutation: ctx.withMutation,
    commit: ctx.commit,
    onStorageError,
    deadlineWarningMs,
  });
  ctx.scheduleGoalTitle = createGoalTitleScheduler(ctx);
  Object.assign(ctx, createGoalMutations(ctx));
  ctx.control = (sessionId, rawArgs) => runGoalControl(ctx, sessionId, rawArgs);
  const { withMutation, emit, visibleSnapshot, storedSnapshot, deadlines, listeners } = ctx;

  return {
    tools: GOAL_TOOL_DEFS,
    snapshot(sessionId) {
      const goal = visibleSnapshot(sessionId);
      if (goal) deadlines.armDeadline(sessionId);
      return goal;
    },
    storedSnapshot,
    watchSession(sessionId) {
      if (!sessionId) return null;
      const goal = visibleSnapshot(sessionId);
      if (goal) deadlines.armDeadline(sessionId);
      emit(sessionId, goal);
      return goal;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    control(sessionId, args = {}) {
      return withMutation(sessionId, () => ctx.control(sessionId, args));
    },
    executeTool: (name, args = {}, context = {}) => executeGoalTool(ctx, name, args, context),
    ...createGoalTurnLifecycle(ctx),
    close() {
      ctx.closed = true;
      for (const job of ctx.titleJobs.values()) job.abort.abort(new Error('Goal runtime closed.'));
      ctx.titleJobs.clear();
      deadlines.close();
      ctx.turnGoalIds.clear();
      ctx.turnStartedAt.clear();
      ctx.observedGoals.clear();
      ctx.idleReviewTurns.clear();
      ctx.continuationTiers.clear();
      listeners.clear();
      // Accepted writes keep their ordering until they settle. Callers may
      // await this barrier before releasing the session's backing resources.
      return Promise.allSettled([...ctx.mutationChains.values()]).then(() => {});
    },
  };
}
