/**
 * goal-store.mjs — the per-session Goal record: serialized mutations, the
 * commit, listener publication and the visible/stored
 * snapshots. Everything here reads and writes through the shared runtime
 * record (`ctx`) assembled by createGoalRuntime.
 */
import { join } from 'node:path';

import { createGoalStorage, deleteStoredGoalFile } from './goal-storage.mjs';
import {
  GOAL_FILE_VERSION,
  assertSessionId,
  completedGoalExpired,
  discardUnobservedTime,
  normalizeStoredGoal,
  publicGoal,
} from './goal-state.mjs';

export function createGoalStore(ctx) {
  const { root, dataDir, now, onStorageError, completedRetentionMs, listeners, mutationChains } = ctx;
  const pathFor = (sessionId) => join(root, `${assertSessionId(sessionId)}.json`);
  // The first load of a session's record in this runtime: whatever stretch of
  // an open clock segment no live runtime ran (closed app, sleeping PC) is not
  // time the Goal spent. Later re-reads are this runtime's own writes.
  const adopted = new Set();
  const storage = createGoalStorage({
    pathFor,
    normalizeGoal(value, sessionId, at) {
      const goal = normalizeStoredGoal(value, sessionId, at);
      if (goal && !adopted.has(sessionId)) {
        adopted.add(sessionId);
        discardUnobservedTime(goal, at);
      }
      return goal;
    },
    now,
    writeRecord: ctx.writeGoalRecord,
  });
  // The committed record, exactly as stored. Only the deadline controller reads
  // it this way: it does its own suspend accounting and needs to see whether a
  // read changed anything.
  const readStoredRecord = storage.read;
  // Every other caller edits what it reads and commits it, and moves
  // `lastStartedAt` or the status on the way. Charging a pending suspend here,
  // before any caller sees the working copy, means no checkpoint or status
  // transition can charge the sleep to the Goal, now or in a future caller.
  const readRecord = (sessionId) => {
    const record = readStoredRecord(sessionId);
    ctx.deadlines.settleSuspended(sessionId, record.goal, now());
    return record;
  };

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

  const commit = async (sessionId, goal, { isCurrent, accept } = {}) => {
    const id = assertSessionId(sessionId);
    // Rollback restores exactly what was stored, not a settled working copy.
    const previous = goal ? readStoredRecord(id).goal : null;
    let committedGoal = null;
    const stampedAt = now();
    if (goal) {
      committedGoal = { ...goal, sessionId: id };
      if (committedGoal.status === 'active') {
        // Stamping liveAt would hide a suspend nobody has charged yet.
        ctx.deadlines.settleSuspended(id, committedGoal, stampedAt);
        committedGoal.liveAt = stampedAt;
      }
    }
    const rollback = async () => {
      try {
        await storage.write(id, { version: GOAL_FILE_VERSION, goal: previous });
      } catch (error) {
        error.quotaResumeRollbackFailed = true;
        throw error;
      }
      ctx.deadlines.armDeadline(id);
    };
    try {
      await storage.write(id, { version: GOAL_FILE_VERSION, goal: committedGoal });
    } catch (error) {
      if (isCurrent || accept) await rollback();
      throw error;
    }
    if (isCurrent || accept) {
      let accepted = false;
      let admissionError = null;
      try {
        accepted = (!isCurrent || isCurrent()) && (!accept || accept() === true);
      } catch (error) {
        admissionError = error;
      }
      if (!accepted) {
        await rollback();
        if (admissionError) throw admissionError;
        return null;
      }
    }
    ctx.deadlines.refreshAnchor(id, stampedAt, committedGoal);
    ctx.deadlines.armDeadline(id);
    emit(id);
    return publicGoal(committedGoal, now());
  };

  // The heartbeat's write: durable liveness only, nothing for listeners.
  const stampLive = (id, goal) => storage.write(id, { version: GOAL_FILE_VERSION, goal: { ...goal, sessionId: id } });

  const requireGoal = (sessionId) => {
    const record = readRecord(sessionId);
    if (!record.goal) throw new Error('no Goal exists for this session');
    return record.goal;
  };

  return {
    readRecord,
    readStoredRecord,
    withMutation,
    storedSnapshot,
    visibleSnapshot,
    emit,
    commit,
    stampLive,
    requireGoal,
  };
}
