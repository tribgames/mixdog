import { randomUUID } from 'node:crypto';
import { clean } from '../runtime/shared/clean.mjs';
import { compactSessionTitle } from './session-title.mjs';
import { MAX_GOAL_TIME_LIMIT_MS } from './goal-tool-defs.mjs';
import { goalTaskProgress, normalizeGoalTasks } from './goal-tasks.mjs';

export const DEFAULT_GOAL_TIME_LIMIT_MS = 0;
export const DEFAULT_COMPLETED_GOAL_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GOAL_DEADLINE_WARNING_MS = Object.freeze([10 * 60_000, 5 * 60_000]);
export const NO_DEADLINE_WARNING_MS = Number.MAX_SAFE_INTEGER;
export const GOAL_FILE_VERSION = 1;
export const SESSION_ID = /^[A-Za-z0-9_-]+$/;
export const GOAL_STATUS_VALUES = Object.freeze([
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'duration_reached',
  'complete',
  'stopped',
]);

const MAX_OBJECTIVE_LENGTH = 4_000;
const MAX_GOAL_BLOCKER_LENGTH = 1_000;
const ACTIVE_AGENT_STATUSES = new Set([
  'connecting',
  'requesting',
  'streaming',
  'tool_running',
  'running',
  'cancelling',
]);

export function assertSessionId(value) {
  const sessionId = clean(value);
  if (!SESSION_ID.test(sessionId)) throw new Error(`goal: invalid session id ${JSON.stringify(value)}`);
  return sessionId;
}

export function validateObjective(value) {
  const objective = clean(value);
  if (!objective) throw new Error('goal objective is required');
  if ([...objective].length > MAX_OBJECTIVE_LENGTH) {
    throw new Error(`goal objective exceeds ${MAX_OBJECTIVE_LENGTH} characters`);
  }
  return objective;
}

export function validateGoalBlocker(value) {
  const blocker = clean(value);
  if (!blocker) throw new Error('goal block: blocker is required');
  if ([...blocker].length > MAX_GOAL_BLOCKER_LENGTH) {
    throw new Error(`goal blocker exceeds ${MAX_GOAL_BLOCKER_LENGTH} characters`);
  }
  return blocker;
}

export function goalTimeMode(value, fallback = 'max') {
  if (value == null || value === '') return fallback;
  if (!['max', 'duration'].includes(value)) throw new Error('goal timeMode must be max or duration');
  return value;
}

export function parseGoalDuration(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error('goal duration must be positive');
    const milliseconds = Math.round(value);
    if (milliseconds > MAX_GOAL_TIME_LIMIT_MS) throw new Error('goal duration exceeds 7 days');
    return milliseconds;
  }
  const text = clean(value).toLowerCase().replace(/\s+/g, '');
  if (!text) throw new Error('goal duration is required');
  let total = 0;
  let matched = 0;
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) {
    if (match.index !== matched) throw new Error(`invalid goal duration: ${value}`);
    total += Number(match[1]) * unitMs[match[2]];
    matched += match[0].length;
  }
  if (matched !== text.length || !Number.isFinite(total) || total < 60_000) {
    throw new Error('goal duration must be at least 1 minute (for example 30m, 2h, or 1h30m)');
  }
  if (total > MAX_GOAL_TIME_LIMIT_MS) throw new Error('goal duration exceeds 7 days');
  return Math.round(total);
}

export function parseUserCommand(command) {
  const value = clean(command);
  if (!value) return { action: 'get' };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(value);
  const token = clean(match?.[1]).toLowerCase();
  const rest = clean(match?.[2]);
  if (['status', 'show', 'current'].includes(token)) return { action: 'get' };
  if (['pause', 'stop', 'clear', 'complete'].includes(token)) return { action: token };
  if (token === 'resume') return { action: 'resume', duration: rest || null };
  if (token === 'edit') return { action: 'edit', objective: rest };
  if (token === 'time') return { action: 'time', duration: rest };

  let objective = value;
  let duration = null;
  let timeMode = 'max';
  const modeMatch = objective.match(/(?:^|\s)--time-mode(?:=|\s+)([^\s]+)/i);
  if (modeMatch) {
    timeMode = goalTimeMode(modeMatch[1]);
    objective = objective.replace(modeMatch[0], ' ').trim();
  }
  const equalsMatch = objective.match(/(?:^|\s)--time=([^\s]+)/i);
  if (equalsMatch) {
    duration = equalsMatch[1];
    objective = objective.replace(equalsMatch[0], ' ').trim();
  } else {
    const spacedMatch = objective.match(/(?:^|\s)--time\s+([^\s]+)/i);
    if (spacedMatch) {
      duration = spacedMatch[1];
      objective = objective.replace(spacedMatch[0], ' ').trim();
    }
  }
  return { action: 'create', objective, duration, timeMode };
}

export function normalizeStoredGoal(value, sessionId, resumedAt = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  // Version-1 records include this terminal status. Never revive elapsed work.
  const status = value.status === 'budget_limited' ? 'duration_reached' : value.status;
  if (!GOAL_STATUS_VALUES.includes(status)) throw new Error(`invalid stored Goal status: ${status}`);
  const storedTimeLimitMs = Number(value.timeLimitMs);
  const timeLimitMs =
    Number.isFinite(storedTimeLimitMs) && storedTimeLimitMs > 0
      ? Math.min(MAX_GOAL_TIME_LIMIT_MS, Math.max(60_000, storedTimeLimitMs))
      : 0;
  return {
    id: clean(value.id) || randomUUID(),
    revision: Math.max(1, Math.floor(Number(value.revision) || 1)),
    objectiveRevision: Math.max(1, Math.floor(Number(value.objectiveRevision) || 1)),
    tasksObjectiveRevision: Math.max(1, Math.floor(Number(value.tasksObjectiveRevision) || 1)),
    sessionId,
    objective: validateObjective(value.objective),
    title: compactSessionTitle(value.title || value.objective),
    status,
    tasks: normalizeGoalTasks(value.tasks ?? value.criteria ?? []),
    blocker: clean(value.blocker),
    pauseReason: ['waiting', 'cancelled'].includes(value.pauseReason) ? value.pauseReason : 'user',
    blockAudit: value.blockAudit && typeof value.blockAudit === 'object' ? value.blockAudit : null,
    failureReason: clean(value.failureReason),
    failureCount: Math.max(0, Math.floor(Number(value.failureCount) || 0)),
    // Observations report progress; they never decide when work is complete.
    turnCount: Math.max(0, Math.floor(Number(value.turnCount) || 0)),
    // Dropped work must survive the turn that removed it before completion.
    lastDropTurn:
      Number.isInteger(value.lastDropTurn) &&
      (value.revision != null ||
        value.lastDropTurn !== 0 ||
        (value.tasks || []).some((task) => task.status === 'dropped'))
        ? value.lastDropTurn
        : -1,
    tasksUpdatedAt: Number(value.tasksUpdatedAt) > 0 ? Number(value.tasksUpdatedAt) : null,
    timeLimitMs,
    // Unversioned durations retain their original full-period commitment.
    timeMode: goalTimeMode(value.timeMode, 'duration'),
    timeUsedMs: Math.max(0, Number(value.timeUsedMs) || 0),
    createdAt: Math.max(0, Number(value.createdAt) || Date.now()),
    updatedAt: Math.max(0, Number(value.updatedAt) || Date.now()),
    // Preserve the open segment across task writes, eviction, and restart.
    lastStartedAt:
      status === 'active' ? Math.max(0, Number(value.lastStartedAt) || Number(resumedAt) || Date.now()) : null,
    completedAt: Number(value.completedAt) > 0 ? Number(value.completedAt) : null,
    stoppedAt: Number(value.stoppedAt) > 0 ? Number(value.stoppedAt) : null,
    archivedAt: Number(value.archivedAt) > 0 ? Number(value.archivedAt) : null,
    deadlineWarnedMs: normalizeDeadlineWarnedMs(value.deadlineWarnedMs),
    warningRevision: Math.max(0, Math.floor(Number(value.warningRevision) || 0)),
  };
}

export function activeElapsedMs(goal, now = Date.now()) {
  const committed = Math.max(0, Number(goal?.timeUsedMs) || 0);
  if (goal?.status !== 'active' || !(Number(goal?.lastStartedAt) > 0)) return committed;
  return committed + Math.max(0, now - Number(goal.lastStartedAt));
}

// The smallest delivered threshold is the durable, at-most-once watermark.
export function normalizeDeadlineWarnedMs(value) {
  const warned = Number(value);
  return Number.isFinite(warned) && warned >= 0 ? warned : NO_DEADLINE_WARNING_MS;
}

export function publicGoal(goal, now = Date.now()) {
  if (!goal) return null;
  const timeUsedMs = activeElapsedMs(goal, now);
  const hasTimeLimit = Number(goal.timeLimitMs) > 0;
  const remainingMs = hasTimeLimit ? Math.max(0, Number(goal.timeLimitMs) - timeUsedMs) : null;
  const tasks = normalizeGoalTasks(goal.tasks || []);
  return {
    id: goal.id,
    revision: goal.revision,
    // Warning delivery does not invalidate the actionable task revision.
    warningRevision: Math.max(0, Math.floor(Number(goal.warningRevision) || 0)),
    needsTaskReview: goal.tasksObjectiveRevision !== goal.objectiveRevision,
    sessionId: goal.sessionId,
    objective: goal.objective,
    title: goal.title || compactSessionTitle(goal.objective),
    status: goal.status,
    tasks,
    turnCount: Math.max(0, Math.floor(Number(goal.turnCount) || 0)),
    tasksUpdatedAt: Number(goal.tasksUpdatedAt) > 0 ? Number(goal.tasksUpdatedAt) : null,
    ...goalTaskProgress(tasks),
    blocker: goal.blocker || '',
    pauseReason: goal.pauseReason || 'user',
    blockAudit: goal.blockAudit || null,
    timeLimitMs: goal.timeLimitMs,
    timeMode: goal.timeMode,
    timeUsedMs,
    remainingMs,
    deadlineAt: hasTimeLimit && goal.status === 'active' && goal.lastStartedAt ? now + remainingMs : null,
    snapshotAt: now,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    lastStartedAt: goal.lastStartedAt,
    completedAt: goal.completedAt,
    stoppedAt: goal.stoppedAt,
    archivedAt: goal.archivedAt,
  };
}

export function normalizedCompletedGoalTtlMs(value) {
  const ttlMs = Number(value);
  return Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_COMPLETED_GOAL_TTL_MS;
}

export function completedGoalExpired(goal, at, ttlMs = DEFAULT_COMPLETED_GOAL_TTL_MS) {
  if (goal?.status !== 'complete') return false;
  const completedAt = Number(goal.completedAt) || Number(goal.updatedAt) || Number(goal.createdAt) || 0;
  return completedAt > 0 && at - completedAt >= normalizedCompletedGoalTtlMs(ttlMs);
}

export function checkpointActiveClock(goal, now = Date.now()) {
  if (!goal.lastStartedAt) return;
  goal.timeUsedMs = Math.max(0, Number(goal.timeUsedMs) || 0) + Math.max(0, now - Number(goal.lastStartedAt));
  goal.lastStartedAt = now;
}

export function stopActiveClock(goal, now = Date.now()) {
  checkpointActiveClock(goal, now);
  goal.lastStartedAt = null;
}

export function clearTurnFailures(goal) {
  goal.failureReason = '';
  goal.failureCount = 0;
}

export function activateGoal(goal, now = Date.now()) {
  goal.status = 'active';
  goal.lastStartedAt = now;
  goal.completedAt = null;
  goal.archivedAt = null;
  goal.blocker = '';
  goal.blockAudit = null;
  // A running Goal has no pause to explain. Leaving the previous reason behind
  // left active records reading as a wait that had already ended.
  goal.pauseReason = 'user';
  clearTurnFailures(goal);
}

export function resumeGoalState(goal, at, added = null) {
  stopActiveClock(goal, at);
  if (added != null) {
    goal.timeLimitMs = parseGoalDuration(goal.timeUsedMs + added);
    goal.deadlineWarnedMs = NO_DEADLINE_WARNING_MS;
  }
  if (goal.timeLimitMs > 0 && goal.timeLimitMs <= goal.timeUsedMs) {
    throw new Error(
      'Goal time budget is exhausted; extend the time budget before resuming with user-approved time_limit_minutes'
    );
  }
  activateGoal(goal, at);
  goal.updatedAt = at;
}

export function startActiveClock(goal, now = Date.now()) {
  if (goal.status === 'active' && !goal.lastStartedAt) goal.lastStartedAt = now;
}

export function runningAgentWork(agentStatus) {
  const jobs = Array.isArray(agentStatus?.agentJobs) ? agentStatus.agentJobs : [];
  if (jobs.some((job) => clean(job?.status).toLowerCase() === 'running')) return true;
  const workers = Array.isArray(agentStatus?.agentWorkers) ? agentStatus.agentWorkers : [];
  return workers.some((worker) => {
    const status = clean(worker?.status).toLowerCase();
    const stage = clean(worker?.stage || worker?.worker_stage).toLowerCase();
    return ACTIVE_AGENT_STATUSES.has(status) || ACTIVE_AGENT_STATUSES.has(stage);
  });
}
