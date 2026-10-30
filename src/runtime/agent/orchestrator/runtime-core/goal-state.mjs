import { randomUUID } from 'node:crypto';
import { clean } from '../../../shared/clean.mjs';
import { compactSessionTitle } from './session-title.mjs';
import { MAX_GOAL_TIME_LIMIT_MS } from './goal-tool-defs.mjs';
import { SESSION_ID_PATTERN } from './session-id.mjs';

export const DEFAULT_GOAL_TIME_LIMIT_MS = 0;
export const DEFAULT_COMPLETED_GOAL_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GOAL_DEADLINE_WARNING_MS = Object.freeze([10 * 60_000, 5 * 60_000]);
export const NO_DEADLINE_WARNING_MS = Number.MAX_SAFE_INTEGER;
export const GOAL_FILE_VERSION = 1;
// A live runtime re-stamps an active Goal's `liveAt` this often; a longer gap
// means nothing was running it (app closed, PC asleep).
export const GOAL_LIVE_HEARTBEAT_MS = 60_000;
export const GOAL_LIVE_STALE_MS = 3 * GOAL_LIVE_HEARTBEAT_MS;export const SESSION_ID = SESSION_ID_PATTERN;
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
  // The user's confirmation that a new Goal replaces a stalled one, naming it:
  // `--replace=<goal id>`.
  const replaceMatch = objective.match(/(?:^|\s)--replace(?:=(\S+))?(?=\s|$)/i);
  if (replaceMatch) objective = objective.replace(replaceMatch[0], ' ').trim();
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
  return {
    action: 'create',
    objective,
    duration,
    ...(replaceMatch ? { replace: true, ...(replaceMatch[1] ? { expectedGoalId: replaceMatch[1] } : {}) } : {}),
  };
}

function storedTimeLimitMs(value) {
  const stored = Number(value.timeLimitMs);
  return Number.isFinite(stored) && stored > 0 ? Math.min(MAX_GOAL_TIME_LIMIT_MS, Math.max(60_000, stored)) : 0;
}

// Tasks a record written before the todo list carried: kept on the record
// only until the session's todo list adopts them (todo-list.mjs).
function storedLegacyTasks(value) {
  const tasks = value.legacyTasks ?? value.tasks ?? value.criteria;
  return Array.isArray(tasks) && tasks.length
    ? tasks
        .filter((task) => task && typeof task === 'object' && clean(task.text ?? task.content))
        .map((task) => ({ text: clean(task.text ?? task.content), status: clean(task.status) || 'pending' }))
    : [];
}

export function normalizeStoredGoal(value, sessionId, resumedAt = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  // Version-1 records include this terminal status. Never revive elapsed work.
  const status = value.status === 'budget_limited' ? 'duration_reached' : value.status;
  if (!GOAL_STATUS_VALUES.includes(status)) throw new Error(`invalid stored Goal status: ${status}`);
  return {
    id: clean(value.id) || randomUUID(),
    sessionId,
    objective: validateObjective(value.objective),
    title: compactSessionTitle(value.title || value.objective),
    status,
    legacyTasks: storedLegacyTasks(value),
    blocker: clean(value.blocker),
    pauseReason: ['waiting', 'cancelled'].includes(value.pauseReason) ? value.pauseReason : 'user',
    failureReason: clean(value.failureReason),
    failureCount: Math.max(0, Math.floor(Number(value.failureCount) || 0)),
    // Observations report progress; they never decide when work is complete.
    turnCount: Math.max(0, Math.floor(Number(value.turnCount) || 0)),
    timeLimitMs: storedTimeLimitMs(value),
    // Time is an upper bound only: a legacy `duration` record reads as a cap.
    // A record exhausted by an older build may carry wall-clock time past its
    // cap; the cap is what was spent.
    timeUsedMs: cappedTimeUsedMs(
      status === 'duration_reached' ? storedTimeLimitMs(value) : 0,
      Math.max(0, Number(value.timeUsedMs) || 0)
    ),
    createdAt: Math.max(0, Number(value.createdAt) || Date.now()),
    updatedAt: Math.max(0, Number(value.updatedAt) || Date.now()),
    // Preserve the open segment across task writes, eviction, and restart.
    lastStartedAt:
      status === 'active' ? Math.max(0, Number(value.lastStartedAt) || Number(resumedAt) || Date.now()) : null,
    // The last moment a live runtime was running this Goal's open segment.
    liveAt: Math.max(0, Number(value.liveAt) || 0),
    completedAt: Number(value.completedAt) > 0 ? Number(value.completedAt) : null,
    stoppedAt: Number(value.stoppedAt) > 0 ? Number(value.stoppedAt) : null,
    archivedAt: Number(value.archivedAt) > 0 ? Number(value.archivedAt) : null,
    deadlineWarnedMs: normalizeDeadlineWarnedMs(value.deadlineWarnedMs),
    warningRevision: Math.max(0, Math.floor(Number(value.warningRevision) || 0)),
  };
}

function cappedTimeUsedMs(limitMs, usedMs) {
  return limitMs > 0 ? Math.min(limitMs, usedMs) : usedMs;
}

/** Drop the part of an active Goal's open segment that no live runtime ran
 *  (the app was closed, the PC slept): the segment start moves forward by the
 *  unobserved gap. Returns whether anything was dropped. */
export function discardUnobservedTime(goal, at, toleranceMs = 0) {
  if (goal?.status !== 'active' || !(Number(goal.lastStartedAt) > 0)) return false;
  const seenAt = Math.max(Number(goal.lastStartedAt), Number(goal.liveAt) || 0);
  const gap = at - seenAt;
  // The tolerance covers heartbeat jitter inside a live runtime only; a load
  // after downtime passes none, so no closed-app interval is ever credited.
  if (gap <= toleranceMs) return false;
  goal.lastStartedAt = Number(goal.lastStartedAt) + gap;
  goal.liveAt = at;
  return true;
}

/** The Goal as a reader without a runtime sees it. Such a reader cannot know
 *  whether anything is running the Goal, so it uses no clock: the open
 *  segment counts only up to `liveAt`, the last moment a runtime persisted as
 *  having run it (at most one heartbeat behind). That makes the usage a pure
 *  function of the record — never above what the runtime has stored, never
 *  charging downtime, never moving backward between reads. */
export function freezeUnobservedSegment(goal) {
  if (goal?.status !== 'active' || !(Number(goal.lastStartedAt) > 0)) return;
  const observedMs = Math.max(0, (Number(goal.liveAt) || 0) - Number(goal.lastStartedAt));
  goal.timeUsedMs = Math.max(0, Number(goal.timeUsedMs) || 0) + observedMs;
  goal.lastStartedAt = null;
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
  const hasTimeLimit = Number(goal.timeLimitMs) > 0;
  // Never above the cap: a read that lands after the deadline but before the
  // expiry commit reports the cap, not the overshoot.
  const timeUsedMs = cappedTimeUsedMs(Number(goal.timeLimitMs) || 0, activeElapsedMs(goal, now));
  const remainingMs = hasTimeLimit ? Math.max(0, Number(goal.timeLimitMs) - timeUsedMs) : null;
  return {
    id: goal.id,
    // Advances once per delivered deadline warning (deadline-delivery.mjs).
    warningRevision: Math.max(0, Math.floor(Number(goal.warningRevision) || 0)),
    sessionId: goal.sessionId,
    objective: goal.objective,
    title: goal.title || compactSessionTitle(goal.objective),
    status: goal.status,
    turnCount: Math.max(0, Math.floor(Number(goal.turnCount) || 0)),
    blocker: goal.blocker || '',
    pauseReason: goal.pauseReason || 'user',
    timeLimitMs: goal.timeLimitMs,
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

/** The Goal as a published state lane. `publicGoal` answers "how long right
 *  now", so every read restates timeUsedMs/remainingMs/snapshotAt with a new
 *  clock reading — and the 2s route pulse republished the whole Goal to every
 *  desktop and phone while nothing about it had changed. A running clock is
 *  fully described by its open segment: the time committed before it and the
 *  moment it started. Anchoring the snapshot at `lastStartedAt` keeps the wire
 *  shape receivers already read (elapsed = timeUsedMs + (clock - snapshotAt),
 *  deadlineAt fixed) while every read of an unchanged Goal is equal. A stopped
 *  clock has no anchor to carry, so its read time is dropped. Returns the
 *  input itself when nothing needs anchoring. */
export function goalStateSnapshot(goal) {
  if (!goal || typeof goal !== 'object') return goal || null;
  const startedAt = Number(goal.lastStartedAt) || 0;
  const snapshotAt = Number(goal.snapshotAt) || 0;
  if (goal.status !== 'active' || startedAt <= 0) {
    if (!Object.hasOwn(goal, 'snapshotAt')) return goal;
    const { snapshotAt: _readAt, ...stopped } = goal;
    return stopped;
  }
  if (snapshotAt <= 0 || snapshotAt === startedAt) return goal;
  const committed = Math.max(0, (Number(goal.timeUsedMs) || 0) - Math.max(0, snapshotAt - startedAt));
  const limitMs = Number(goal.timeLimitMs) || 0;
  const remainingMs = limitMs > 0 ? Math.max(0, limitMs - committed) : null;
  return {
    ...goal,
    timeUsedMs: committed,
    remainingMs,
    deadlineAt: remainingMs === null ? null : startedAt + remainingMs,
    snapshotAt: startedAt,
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
