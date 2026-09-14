import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { continuationPrompt, durationLabel } from './goal-text.mjs';
import { compactSessionTitle, SESSION_TITLE_TIMEOUT_MS } from './session-title.mjs';
import { GOAL_TOOL_DEFS, GOAL_TASK_SETTLED, MAX_GOAL_TIME_LIMIT_MS, validateGoalToolCall } from './goal-tool-defs.mjs';
import { applyGoalTaskChanges, goalTasksStartWork, normalizeGoalTasks, optionalGoalTaskChanges } from './goal-tasks.mjs';
import { createGoalStorage, deleteStoredGoalFile, reportGoalStorageError } from './goal-storage.mjs';
import { createGoalDeadlines } from './goal-deadlines.mjs';
import {
  DEFAULT_COMPLETED_GOAL_TTL_MS,
  DEFAULT_GOAL_DEADLINE_WARNING_MS,
  DEFAULT_GOAL_TIME_LIMIT_MS,
  GOAL_FILE_VERSION,
  NO_DEADLINE_WARNING_MS,
  activateGoal,
  activeElapsedMs,
  assertSessionId,
  checkpointActiveClock,
  clearTurnFailures,
  completedGoalExpired,
  goalTimeMode,
  normalizeStoredGoal,
  normalizedCompletedGoalTtlMs,
  parseGoalDuration,
  parseUserCommand,
  publicGoal,
  resumeGoalState,
  runningAgentWork,
  startActiveClock,
  stopActiveClock,
  validateGoalBlocker,
  validateObjective,
} from './goal-state.mjs';
import { clean } from '../runtime/shared/clean.mjs';
import { runAbortable } from '../runtime/shared/abort-race.mjs';
import { writeJsonAtomicAsync } from '../runtime/shared/atomic-file.mjs';

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
  const root = join(clean(dataDir) || process.cwd(), 'goals');
  const completedRetentionMs = normalizedCompletedGoalTtlMs(completedGoalTtlMs);
  const listeners = new Set();
  const mutationChains = new Map();
  const turnGoalIds = new Map();
  const turnStartedAt = new Map();
  const titleJobs = new Map();
  const observedGoals = new Map();
  let closed = false;

  const pathFor = (sessionId) => join(root, `${assertSessionId(sessionId)}.json`);
  const storage = createGoalStorage({
    pathFor, normalizeGoal: normalizeStoredGoal, now, writeRecord: writeGoalRecord,
  });
  const readRecord = storage.read;
  const persist = storage.write;

  const withMutation = (sessionId, operation) => {
    const id = assertSessionId(sessionId);
    const previous = mutationChains.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => operation(id));
    mutationChains.set(id, current);
    current.finally(() => {
      if (mutationChains.get(id) === current) mutationChains.delete(id);
    }).catch(() => {});
    return current;
  };

  const emit = (sessionId, goal = visibleSnapshot(sessionId)) => {
    for (const listener of [...listeners]) {
      try { listener({ sessionId, goal }); } catch {}
    }
  };

  const commit = async (sessionId, goal) => {
    const id = assertSessionId(sessionId);
    const previous = goal ? readRecord(id).goal : null;
    const committedGoal = goal
      ? {
        ...goal,
        sessionId: id,
        tasks: Array.isArray(goal.tasks)
          ? goal.tasks.map((task) => ({ ...task }))
          : [],
      }
      : null;
    if (committedGoal) {
      // Clock checkpoints and generated titles must not invalidate a model's
      // task update. Only changes to the actionable state advance its revision.
      const stateKey = (value) => JSON.stringify([
        value?.objective, value?.tasks, value?.status, value?.blocker,
        value?.timeLimitMs, value?.archivedAt, value?.tasksObjectiveRevision,
        value?.timeMode, value?.pauseReason, value?.blockAudit,
      ]);
      committedGoal.revision = previous?.id === goal.id
        ? previous.revision + Number(stateKey(previous) !== stateKey(committedGoal))
        : 1;
    }
    const record = { version: GOAL_FILE_VERSION, goal: committedGoal };
    await persist(id, record);
    armDeadline(id);
    emit(id);
    return publicGoal(committedGoal, now());
  };

  const deadlines = createGoalDeadlines({
    now, readRecord, withMutation, commit, onStorageError, deadlineWarningMs,
  });
  const { armDeadline, clearDeadline, limitIfExpired } = deadlines;

  const scheduleGoalTitle = (sessionId, goal) => {
    if (closed || typeof generateTitle !== 'function' || !goal) return;
    const id = assertSessionId(sessionId);
    const goalId = clean(goal.id);
    const objective = clean(goal.objective);
    titleJobs.get(id)?.abort.abort(new Error('Goal title generation superseded.'));
    const abort = new AbortController();
    const job = { abort };
    titleJobs.set(id, job);
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Goal title generation timed out.');
        abort.abort(error);
        reject(error);
      }, SESSION_TITLE_TIMEOUT_MS);
      timer.unref?.();
    });
    void Promise.race([
      runAbortable(abort.signal, () => generateTitle(objective, { signal: abort.signal })),
      timeout,
    ]).then((rawTitle) => {
      if (closed || abort.signal.aborted || titleJobs.get(id) !== job) return;
      const title = compactSessionTitle(rawTitle);
      if (!title || title === goal.title) return;
      return withMutation(id, async () => {
        if (closed || abort.signal.aborted || titleJobs.get(id) !== job) return;
        const current = readRecord(id).goal;
        if (!current || current.id !== goalId || current.objective !== objective) return;
        current.title = title;
        current.updatedAt = now();
        await commit(id, current);
      });
    }).catch(() => {}).finally(() => {
      if (timer) clearTimeout(timer);
      if (titleJobs.get(id) === job) titleJobs.delete(id);
    });
  };

  const storedSnapshot = (sessionId) => {
    const id = assertSessionId(sessionId);
    const at = now();
    let goal;
    try {
      goal = publicGoal(limitIfExpired(id), at);
    } catch (error) {
      onStorageError(error);
      return null;
    }
    if (!completedGoalExpired(goal, at, completedRetentionMs)) return goal;
    clearDeadline(id);
    if (deleteStoredGoalFile(dataDir, id)) storage.forget(id);
    return null;
  };

  function visibleSnapshot(sessionId) {
    const goal = storedSnapshot(sessionId);
    return goal?.archivedAt ? null : goal;
  }

  const requireGoal = (sessionId) => {
    const record = readRecord(sessionId);
    if (!record.goal) throw new Error('no Goal exists for this session');
    return record.goal;
  };

  const createGoal = async (sessionId, args = {}) => {
    const id = assertSessionId(sessionId);
    const record = readRecord(id);
    if (record.goal && !['complete', 'stopped'].includes(record.goal.status)) {
      // Recovery is part of the message on purpose: without it a stopped Goal
      // (paused/blocked/limited) permanently blocked every later Goal in the
      // session, because the model owns no way to retire one.
      throw new Error(
        `cannot create a new Goal while an unfinished Goal exists (status ${record.goal.status}); `
        + 'resume and finish it, or abandon it if the user redirected away from that objective',
      );
    }
    const at = now();
    const configuredDefaultTimeLimitMs = Number(defaultTimeLimitMs);
    const timeLimitMs = args.timeLimitMs != null
      ? parseGoalDuration(args.timeLimitMs)
      : args.duration
        ? parseGoalDuration(args.duration)
        : Number.isFinite(configuredDefaultTimeLimitMs) && configuredDefaultTimeLimitMs > 0
          ? parseGoalDuration(configuredDefaultTimeLimitMs)
          : 0;
    const initialTasks = Array.isArray(args.tasks)
      ? normalizeGoalTasks(args.tasks.filter((task) => clean(task?.text)), [], { strict: true })
      : [];
    const goal = {
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
      turnCount: args.startInCurrentTurn === true ? 1 : 0,
      lastDropTurn: initialTasks.some((task) => task.status === 'dropped')
        ? (args.startInCurrentTurn === true ? 1 : 0) : -1,
      tasksUpdatedAt: initialTasks.length > 0 ? at : null,
      timeLimitMs,
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
    if (args.startInCurrentTurn === true) {
      const startedAt = record.goal ? at : (turnStartedAt.get(id) || at);
      goal.lastStartedAt = startedAt;
    }
    if (record.goal && ['complete', 'stopped'].includes(record.goal.status)) {
      const write = writeGoalRecord || writeJsonAtomicAsync;
      await write(join(root, 'history', id, `${assertSessionId(record.goal.id)}.json`),
        { version: GOAL_FILE_VERSION, goal: record.goal },
        { lock: true, secret: true, fsync: false, timeoutMs: 2_000 });
    }
    const created = await commit(id, goal);
    if (args.startInCurrentTurn === true) {
      turnGoalIds.set(id, goal.id);
      turnStartedAt.set(id, goal.lastStartedAt);
    }
    scheduleGoalTitle(id, goal);
    return created;
  };

  const updateGoal = async (sessionId, args = {}, { user = false, expectedGoalId = '' } = {}) => {
    const id = assertSessionId(sessionId);
    const goal = requireGoal(id);
    if (clean(expectedGoalId) && clean(expectedGoalId) !== clean(goal.id)) {
      throw new Error('stale Goal update rejected because the active Goal changed');
    }
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
      // Evidence gates the MODEL's completion claim, never the user's. A user
      // completing their own Goal is an act of authority: without this the
      // only user-side exit was deleting the Goal, which threw the record
      // away. Unfinished rows stay unfinished so the record stays honest.
      if (!user) {
        if (goal.tasksObjectiveRevision !== goal.objectiveRevision) {
          throw new Error('cannot complete Goal: objective changed; read goal status and reconcile the full task list with set_tasks first');
        }
        const tasks = normalizeGoalTasks(goal.tasks || []);
        const incomplete = tasks.filter((task) => !GOAL_TASK_SETTLED.includes(task.status));
        if (incomplete.length > 0) {
          throw new Error(`cannot complete Goal: ${incomplete.length} durable tasks remain incomplete`);
        }
        const turnCount = Math.max(0, Math.floor(Number(goal.turnCount) || 0));
        if (goal.lastDropTurn >= 0 && goal.lastDropTurn === turnCount) {
          throw new Error(
            'cannot complete Goal: a task was dropped this turn; only a user scope change retires '
            + 'requested work, so finish that work or let the user confirm the change first',
          );
        }
        if (goal.timeMode === 'duration' && goal.timeLimitMs > 0 && activeElapsedMs(goal, at) < goal.timeLimitMs) {
          throw new Error('cannot complete Goal before the requested duration ends; keep working, or the user may explicitly complete the Goal');
        }
      }
      if (turnGoalIds.get(id) === goal.id) checkpointActiveClock(goal, at);
      else stopActiveClock(goal, at);
      goal.status = 'complete';
      goal.completedAt = at;
      goal.blocker = '';
      clearTurnFailures(goal);
    } else if (status === 'blocked') {
      const blocker = validateGoalBlocker(args.blocker);
      const turn = goal.turnCount;
      const previous = goal.blockAudit;
      const count = previous?.reason === blocker && previous.turn === turn
        ? previous.count
        : previous?.reason === blocker && previous.turn === turn - 1 ? previous.count + 1 : 1;
      goal.blockAudit = { reason: blocker, turn, count };
      if (count < 3) {
        goal.updatedAt = at;
        return commit(id, goal);
      }
      if (turnGoalIds.get(id) === goal.id) checkpointActiveClock(goal, at);
      else stopActiveClock(goal, at);
      goal.status = 'blocked';
      goal.blocker = blocker;
      clearTurnFailures(goal);
    }
    goal.updatedAt = at;
    return commit(id, goal);
  };

  const setGoalTasks = async (sessionId, args = {}, { expectedGoalId = '', partial = false } = {}) => {
    const id = assertSessionId(sessionId);
    const goal = requireGoal(id);
    if (clean(expectedGoalId) && clean(expectedGoalId) !== clean(goal.id)) {
      throw new Error('stale Goal task update rejected because the active Goal changed');
    }
    const at = now();
    const previousTasks = goal.tasks;
    applyGoalTaskChanges(goal, args, { partial, at });
    if (goal.status === 'paused' && goal.pauseReason === 'waiting'
      && goalTasksStartWork(previousTasks, goal.tasks, args, { partial })) {
      // Starting approved work and resuming its Goal are one durable write.
      // Intake, status reads, and bookkeeping alone never grant approval.
      resumeGoalState(goal, at);
    }
    return commit(id, goal);
  };

  // Explicit retirement of a superseded Goal. The create guard stays strict so
  // parallel Goals stay impossible; this is the one way out of it, and it is
  // deliberately an act the model has to take rather than a silent overwrite.
  const abandonGoal = async (sessionId, { expectedGoalId = '', archive = false } = {}) => {
    const id = assertSessionId(sessionId);
    const goal = requireGoal(id);
    if (clean(expectedGoalId) && clean(expectedGoalId) !== clean(goal.id)) {
      throw new Error('stale Goal abandon rejected because the active Goal changed');
    }
    stopActiveClock(goal, now());
    goal.status = 'stopped';
    goal.stoppedAt = now();
    goal.updatedAt = goal.stoppedAt;
    goal.blocker = '';
    // A stopped Goal can neither resume nor be edited, so a user who confirmed
    // the stop has nothing left to do with its chrome: retire it at once. The
    // record stays for history so the unfinished work is still preserved.
    if (archive) goal.archivedAt = goal.stoppedAt;
    await commit(id, goal);
    turnGoalIds.delete(id);
    return publicGoal(goal, now());
  };

  const control = async (sessionId, rawArgs = {}) => {
    const id = assertSessionId(sessionId);
    const args = typeof rawArgs === 'string'
      ? parseUserCommand(rawArgs)
      : rawArgs?.command != null
        ? { ...rawArgs, ...parseUserCommand(rawArgs.command) }
        : rawArgs;
    const action = clean(args?.action || 'get').toLowerCase();
    let goal;
    if (action === 'create') {
      goal = await createGoal(id, {
        objective: args.objective,
        duration: args.duration,
        timeLimitMs: args.timeLimitMs,
        timeMode: args.timeMode,
      });
      return {
        ok: true,
        action,
        goal,
        message: Number(goal.timeLimitMs) > 0
          ? `Goal active · ${goal.objective} · ${durationLabel(goal.remainingMs)} remaining`
          : `Goal active · ${goal.objective} · ${durationLabel(goal.timeUsedMs)} elapsed`,
      };
    }
    if (action === 'get' || action === 'status') {
      goal = visibleSnapshot(id);
      return {
        ok: true,
        action: 'get',
        goal,
        message: goal
          ? `Goal ${goal.status} · ${goal.objective}${goal.status === 'active'
            ? Number(goal.timeLimitMs) > 0
              ? ` · ${durationLabel(goal.remainingMs)} remaining`
              : ` · ${durationLabel(goal.timeUsedMs)} elapsed`
            : ''}`
          : 'No visible Goal for this session',
      };
    }
    if (action === 'clear') {
      await commit(id, null);
      return { ok: true, action, goal: null, message: 'Goal cleared' };
    }
    goal = requireGoal(id);
    const expectedGoalId = clean(args.expectedGoalId);
    if (expectedGoalId && expectedGoalId !== clean(goal.id)) {
      throw new Error('stale Goal update rejected because the active Goal changed');
    }
    if (args.revision != null && args.revision !== goal.revision) {
      throw new Error('Goal changed while editing; reopen the editor before saving');
    }
    const at = now();
    if (goal.status === 'stopped') throw new Error('a stopped Goal cannot be changed; create a new Goal');
    if (action === 'stop') {
      goal = await abandonGoal(id, { expectedGoalId, archive: true });
      return { ok: true, action, goal, message: `Goal stopped · ${goal.objective}` };
    }
    if (action === 'pause') {
      if (goal.status === 'complete') throw new Error('a completed Goal cannot be paused; edit it or create a new Goal');
      if (goal.status === 'active') stopActiveClock(goal, at);
      goal.status = 'paused';
      goal.pauseReason = args.pauseReason === 'waiting' ? 'waiting' : 'user';
      goal.blocker = args.pauseReason === 'waiting' ? validateGoalBlocker(args.blocker) : '';
      clearTurnFailures(goal);
      goal.updatedAt = at;
      goal = await commit(id, goal);
      return { ok: true, action, goal, message: `Goal paused · ${goal.objective}` };
    }
    if (action === 'resume') {
      if (goal.status === 'complete') {
        throw new Error('a completed Goal cannot be resumed; edit it or create a new Goal');
      }
      const added = args.duration ? parseGoalDuration(args.duration) : null;
      const timeMode = goalTimeMode(args.timeMode, goal.timeMode);
      // Empty optional fields from frozen provider schemas still mean a plain
      // resume. Supplied changes validate before activation and share its write.
      const taskChanges = optionalGoalTaskChanges(args);
      const hasTaskChanges = [taskChanges.updates, taskChanges.tasks]
        .some((value) => value != null && (!Array.isArray(value) || value.length > 0));
      if (hasTaskChanges) applyGoalTaskChanges(goal, taskChanges, { partial: true, at });
      resumeGoalState(goal, at, added);
      goal.timeMode = timeMode;
      goal = await commit(id, goal);
      return {
        ok: true,
        action,
        goal,
        message: Number(goal.timeLimitMs) > 0
          ? `Goal resumed · ${goal.objective} · ${durationLabel(goal.remainingMs)} remaining`
          : `Goal resumed · ${goal.objective} · ${durationLabel(goal.timeUsedMs)} elapsed`,
      };
    }
    if (action === 'edit') {
      // Tasks survive an objective edit. The desktop "Edit goal" button drafts
      // the CURRENT objective, so wiping the list meant refining one word threw
      // away every completed row; re-aligning a stale list is set_tasks' job.
      const objective = validateObjective(args.objective);
      const timeLimitMs = args.timeLimitMs != null
        ? (args.timeLimitMs === 0 ? 0 : parseGoalDuration(args.timeLimitMs))
        : args.duration != null ? parseGoalDuration(args.duration) : goal.timeLimitMs;
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
      goal = await commit(id, goal);
      scheduleGoalTitle(id, goal);
      return { ok: true, action, goal, message: `Goal updated · ${goal.objective}` };
    }
    if (action === 'time') {
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
      goal = await commit(id, goal);
      return { ok: true, action, goal, message: `Goal duration · ${durationLabel(limit)}` };
    }
    if (action === 'complete') {
      goal = await updateGoal(id, { status: 'complete' }, { user: true });
      return { ok: true, action, goal, message: `Goal complete · ${goal.objective} · ${durationLabel(goal.timeUsedMs)} elapsed` };
    }
    throw new Error(`unknown Goal action: ${action}`);
  };

  const observeGoal = (id, goal) => {
    if (goal) observedGoals.set(id, { id: goal.id, revision: goal.revision });
    else observedGoals.delete(id);
  };

  const toolReply = (id, goal, { full = false, previousIds = null } = {}) => {
    observeGoal(id, goal);
    const result = {
      goal: !goal || full ? goal : {
        id: goal.id, revision: goal.revision, status: goal.status,
        tasksCompleted: goal.tasksCompleted, tasksTotal: goal.tasksTotal,
        tasksUpdatedAt: goal.tasksUpdatedAt, timeUsedMs: goal.timeUsedMs,
        ...(goal.blocker ? { blocker: goal.blocker } : {}),
        ...(goal.blockAudit ? { blockAudit: goal.blockAudit } : {}),
        ...(goal.needsTaskReview ? { needsTaskReview: true } : {}),
      },
      remaining_ms: goal?.remainingMs ?? null,
    };
    if (!full && previousIds && goal) {
      const added = goal.tasks.filter((task) => !previousIds.has(task.id));
      if (added.length) result.assigned_tasks = added.map(({ id: taskId, text }) => ({ id: taskId, text }));
    }
    return JSON.stringify(result);
  };

  const mutateObserved = (id, args, operation) => {
    const current = requireGoal(id);
    const expectedGoalId = turnGoalIds.get(id) || current.id;
    const observed = observedGoals.get(id);
    // Capture BEFORE queueing: two concurrent calls based on one snapshot
    // must not both overwrite it. Old frozen schemas use the last tool result.
    const expectedRevision = args.revision != null && args.revision !== ''
      ? args.revision
      : (observed?.id === expectedGoalId ? observed.revision : current.revision);
    return withMutation(id, () => {
      const latest = requireGoal(id);
      if (latest.id !== expectedGoalId) throw new Error('stale Goal update rejected because the active Goal changed');
      if (latest.revision !== expectedRevision) throw new Error(`stale Goal revision: expected ${expectedRevision}, current ${latest.revision}; read goal status and reconcile before retrying`);
      return operation(expectedGoalId);
    });
  };

  const executeTool = async (name, args = {}, context = {}) => {
    const sessionId = context.callerSessionId || context.sessionId;
    const id = assertSessionId(sessionId);
    if (name === 'goal') {
      const action = validateGoalToolCall(args);
      if (action === 'status') {
        // Same view the user sees. Reading the stored record here showed the
        // model Goals the user had already archived away.
        readRecord(id); // Corruption is an actionable error, not "no Goal".
        return toolReply(id, visibleSnapshot(id), { full: true });
      }
      let timeLimitMs;
      if (['create', 'resume'].includes(action)
        && args.time_limit_minutes != null && args.time_limit_minutes !== '') {
        const minutes = Number(args.time_limit_minutes);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          throw new Error('goal time_limit_minutes must be a positive number');
        }
        timeLimitMs = parseGoalDuration(minutes * 60_000);
      }
      if (action === 'create') {
        const goal = await withMutation(id, () => createGoal(id, {
          objective: args.objective,
          tasks: args.tasks,
          startInCurrentTurn: true,
          ...(timeLimitMs != null ? { timeLimitMs } : {}),
          timeMode: args.time_mode,
        }));
        return toolReply(id, goal, { full: true });
      }
      if (action === 'abandon') {
        const goal = await mutateObserved(id, args, (expectedGoalId) => abandonGoal(id, { expectedGoalId }));
        return toolReply(id, goal);
      }
      if (action === 'pause' || action === 'resume') {
        const result = await mutateObserved(id, args, (expectedGoalId) => {
          const current = requireGoal(id);
          if (['complete', 'stopped'].includes(current.status)) {
            throw new Error(`a ${current.status === 'complete' ? 'completed' : 'stopped'} Goal cannot be paused or resumed`);
          }
          if (action === 'pause') {
            const remaining = current.tasks.filter((task) => !GOAL_TASK_SETTLED.includes(task.status));
            if (!remaining.length || remaining.some((task) => task.status !== 'awaiting_approval')) {
              throw new Error('cannot pause Goal: continue available work; park every user-dependent remaining task as awaiting_approval first');
            }
          }
          return control(id, {
            action, expectedGoalId,
            ...(action === 'resume' ? {
              updates: args.updates, tasks: args.tasks,
              duration: timeLimitMs, timeMode: args.time_mode,
            }
              : { pauseReason: 'waiting', blocker: args.blocker }),
          });
        });
        return toolReply(id, result.goal, { full: action === 'resume' });
      }
      if (action === 'set_tasks' || action === 'update_tasks') {
        let previousIds;
        const goal = await mutateObserved(id, args, (expectedGoalId) => {
          previousIds = new Set(requireGoal(id).tasks.map((task) => task.id));
          return setGoalTasks(id, args, { expectedGoalId, partial: action === 'update_tasks' });
        });
        return toolReply(id, goal, { previousIds });
      }
      const goal = await mutateObserved(id, args, (expectedGoalId) => updateGoal(id, {
        status: action === 'block' ? 'blocked' : 'complete',
        ...(action === 'block' ? { blocker: args.blocker } : {}),
      }, { expectedGoalId }));
      return toolReply(id, goal);
    }
    throw new Error(`unknown Goal tool: ${name}`);
  };

  return {
    tools: GOAL_TOOL_DEFS,
    snapshot(sessionId) {
      const goal = visibleSnapshot(sessionId);
      if (goal) armDeadline(sessionId);
      return goal;
    },
    storedSnapshot,
    watchSession(sessionId) {
      if (!sessionId) return null;
      const goal = visibleSnapshot(sessionId);
      if (goal) armDeadline(sessionId);
      emit(sessionId, goal);
      return goal;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    control(sessionId, args = {}) {
      return withMutation(sessionId, () => control(sessionId, args));
    },
    executeTool,
    startTurn(sessionId) {
      return withMutation(sessionId, async (id) => {
        const goal = readRecord(id).goal;
        if (!goal) {
          turnGoalIds.delete(id);
          turnStartedAt.delete(id);
          return null;
        }
        const at = now();
        turnGoalIds.set(id, goal.id);
        turnStartedAt.set(id, at);
        observeGoal(id, publicGoal(goal, at));
        if (goal.status !== 'active') return visibleSnapshot(id);
        goal.turnCount = Math.max(0, Math.floor(Number(goal.turnCount) || 0)) + 1;
        startActiveClock(goal, at);
        goal.updatedAt = at;
        return commit(id, goal);
      });
    },
    settleTurn(sessionId, detail = {}) {
      return withMutation(sessionId, async (id) => {
        const expectedGoalId = turnGoalIds.get(id) || '';
        turnGoalIds.delete(id);
        turnStartedAt.delete(id);
        const goal = readRecord(id).goal;
        if (!goal || (expectedGoalId && goal.id !== expectedGoalId)) return visibleSnapshot(id);
        const at = now();
        if (detail?.preserveGoalState === true) {
          if (goal.status === 'active') checkpointActiveClock(goal, at);
          goal.updatedAt = at;
          return commit(id, goal);
        }
        const status = clean(typeof detail === 'string' ? detail : detail.status).toLowerCase();
        const usageLimited = detail?.usageLimited === true || detail?.usage_limited === true;
        if (usageLimited && ['active', 'duration_reached'].includes(goal.status)) {
          stopActiveClock(goal, at);
          clearTurnFailures(goal);
          goal.status = 'usage_limited';
          goal.blocker = clean(detail?.error) || 'Provider usage limit reached';
        } else if (status === 'cancelled' && goal.status === 'active') {
          stopActiveClock(goal, at);
          clearTurnFailures(goal);
          goal.status = 'paused';
          goal.pauseReason = 'user';
          goal.blocker = '';
        } else if (status === 'failed' && goal.status === 'active') {
          // A failed turn has exhausted its recovery. Starting another Goal
          // turn retries the same terminal error with a larger transcript.
          // The model's separate external-blocker audit still spans 3 turns.
          stopActiveClock(goal, at);
          goal.status = 'blocked';
          goal.failureReason = clean(detail?.error) || 'Goal turn failed';
          goal.failureCount = 1;
          goal.blocker = goal.failureReason;
        } else {
          clearTurnFailures(goal);
        }
        if (goal.status === 'active') {
          checkpointActiveClock(goal, at);
          if (goal.timeLimitMs > 0 && goal.timeUsedMs >= goal.timeLimitMs) {
            stopActiveClock(goal, at);
            goal.status = 'duration_reached';
            goal.timeUsedMs = Math.max(goal.timeUsedMs, goal.timeLimitMs);
          }
        }
        goal.updatedAt = at;
        return commit(id, goal);
      });
    },
    continuation(sessionId, { agentStatus = null } = {}) {
      const goal = visibleSnapshot(sessionId);
      if (!goal || goal.status !== 'active') return { run: false, reason: goal?.status || 'missing', goal };
      if (runningAgentWork(agentStatus)) return { run: false, reason: 'agent-running', goal };
      if (goal.timeMode === 'duration' && goal.remainingMs > 0
        && !goal.needsTaskReview && goal.tasks.length > 0
        && goal.tasks.every((task) => GOAL_TASK_SETTLED.includes(task.status))
        && goal.blockAudit?.turn !== goal.turnCount) {
        // Completed rows do not complete the objective or shorten its duration.
        // The existing deadline timer owns this wait and delivers closeout;
        // task/scope changes still publish and wake newly actionable work.
        return { run: false, reason: 'duration-wait', goal };
      }
      return { run: true, reason: 'idle', goal, prompt: continuationPrompt(goal) };
    },
    async archiveCompletedOnUserInput(sessionId) {
      if (!sessionId) return null;
      return withMutation(sessionId, async (id) => {
        const goal = readRecord(id).goal;
        // A model-abandoned Goal retires the same way a completed one does:
        // the user's next prompt is the acknowledgement that supersedes it.
        if (!goal || !['complete', 'stopped'].includes(goal.status) || goal.archivedAt) return visibleSnapshot(id);
        const at = now();
        goal.archivedAt = at;
        goal.updatedAt = at;
        await commit(id, goal);
        return null;
      });
    },
    close() {
      closed = true;
      for (const job of titleJobs.values()) job.abort.abort(new Error('Goal runtime closed.'));
      titleJobs.clear();
      deadlines.close();
      turnGoalIds.clear();
      turnStartedAt.clear();
      observedGoals.clear();
      listeners.clear();
      // Accepted writes keep their ordering until they settle. Callers may
      // await this barrier before releasing the session's backing resources.
      return Promise.allSettled([...mutationChains.values()]).then(() => {});
    },
  };
}
