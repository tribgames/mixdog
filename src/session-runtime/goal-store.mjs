/**
 * goal-store.mjs — the per-session Goal record: serialized mutations, the
 * revision-bumping commit, listener publication and the visible/stored
 * snapshots. Everything here reads and writes through the shared runtime
 * record (`ctx`) assembled by createGoalRuntime.
 */
import { join } from 'node:path';

import { createGoalStorage, deleteStoredGoalFile } from './goal-storage.mjs';
import {
  GOAL_FILE_VERSION,
  assertSessionId,
  completedGoalExpired,
  normalizeStoredGoal,
  publicGoal,
} from './goal-state.mjs';

// Clock checkpoints and generated titles must not invalidate a model's task
// update. Only changes to the actionable state advance the revision.
const REVISION_STATE_FIELDS = [
  'objective',
  'tasks',
  'status',
  'blocker',
  'timeLimitMs',
  'archivedAt',
  'tasksObjectiveRevision',
  'timeMode',
  'pauseReason',
  'blockAudit',
];

function revisionStateKey(goal) {
  return JSON.stringify(REVISION_STATE_FIELDS.map((field) => goal?.[field]));
}

export function createGoalStore(ctx) {
  const { root, dataDir, now, onStorageError, completedRetentionMs, listeners, mutationChains } = ctx;
  const pathFor = (sessionId) => join(root, `${assertSessionId(sessionId)}.json`);
  const storage = createGoalStorage({
    pathFor,
    normalizeGoal: normalizeStoredGoal,
    now,
    writeRecord: ctx.writeGoalRecord,
  });
  const readRecord = storage.read;

  const withMutation = (sessionId, operation) => {
    const id = assertSessionId(sessionId);
    const previous = mutationChains.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => operation(id));
    mutationChains.set(id, current);
    current
      .finally(() => {
        if (mutationChains.get(id) === current) mutationChains.delete(id);
      })
      .catch(() => {});
    return current;
  };

  const storedSnapshot = (sessionId) => {
    const id = assertSessionId(sessionId);
    const at = now();
    let goal;
    try {
      goal = publicGoal(ctx.deadlines.limitIfExpired(id), at);
    } catch (error) {
      onStorageError(error);
      return null;
    }
    if (!completedGoalExpired(goal, at, completedRetentionMs)) return goal;
    ctx.deadlines.clearDeadline(id);
    if (deleteStoredGoalFile(dataDir, id)) storage.forget(id);
    return null;
  };

  const visibleSnapshot = (sessionId) => {
    const goal = storedSnapshot(sessionId);
    return goal?.archivedAt ? null : goal;
  };

  const emit = (sessionId, goal = visibleSnapshot(sessionId)) => {
    for (const listener of [...listeners]) {
      try {
        listener({ sessionId, goal });
      } catch {}
    }
  };

  const commit = async (sessionId, goal) => {
    const id = assertSessionId(sessionId);
    const previous = goal ? readRecord(id).goal : null;
    let committedGoal = null;
    if (goal) {
      committedGoal = {
        ...goal,
        sessionId: id,
        tasks: Array.isArray(goal.tasks) ? goal.tasks.map((task) => ({ ...task })) : [],
      };
      committedGoal.revision =
        previous?.id === goal.id
          ? previous.revision + Number(revisionStateKey(previous) !== revisionStateKey(committedGoal))
          : 1;
    }
    await storage.write(id, { version: GOAL_FILE_VERSION, goal: committedGoal });
    ctx.deadlines.armDeadline(id);
    emit(id);
    return publicGoal(committedGoal, now());
  };

  const requireGoal = (sessionId) => {
    const record = readRecord(sessionId);
    if (!record.goal) throw new Error('no Goal exists for this session');
    return record.goal;
  };

  return { readRecord, withMutation, storedSnapshot, visibleSnapshot, emit, commit, requireGoal };
}
