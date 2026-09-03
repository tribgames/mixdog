import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomicAsync } from '../runtime/shared/atomic-file.mjs';
import { escapeGoalPromptText, goalTaskLines } from './goal-text.mjs';
import { compactSessionTitle, SESSION_TITLE_TIMEOUT_MS } from './session-title.mjs';

export const DEFAULT_GOAL_TIME_LIMIT_MS = 0;
export const DEFAULT_COMPLETED_GOAL_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_GOAL_TIME_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
export const GOAL_STATUS_VALUES = Object.freeze([
  'active',
  'paused',
  'blocked',
  'usage_limited',
  // Natural end of a requested duration ("keep at this for an hour"), not a
  // spend cap: the time value says how long to keep working, so reaching it is
  // a normal stop rather than a failure.
  'duration_reached',
  'complete',
]);

const GOAL_FILE_VERSION = 1;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const MAX_OBJECTIVE_LENGTH = 4_000;
const MAX_GOAL_TASKS = 20;
const MAX_GOAL_TASK_LENGTH = 500;
const MAX_GOAL_BLOCKER_LENGTH = 1_000;
const ACTIVE_AGENT_STATUSES = new Set(['connecting', 'requesting', 'streaming', 'tool_running', 'running', 'cancelling']);
const GOAL_TASK_STATUSES = Object.freeze([
  'pending', 'in_progress', 'completed', 'dropped', 'awaiting_approval',
]);
// Settled = no longer owed. A dropped task is retired work the objective no
// longer needs: it stops blocking completion and may be omitted from a later
// snapshot, but it stays visible until then. Without it, a task killed by a
// scope change could only be cleared by falsely marking it completed.
const GOAL_TASK_SETTLED = Object.freeze(['completed', 'dropped']);

const goalTaskSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable id from goal status; omit for new work.' },
    text: { type: 'string', description: 'Required work or verification outcome.' },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'dropped', 'awaiting_approval'],
      description: 'Mark completed only when fully accomplished; dropped retires work only after the user changed the objective; awaiting_approval parks work until the user answers.',
    },
    kind: {
      type: 'string',
      enum: ['work', 'verification'],
      description: 'Verification directly checks the finished objective.',
    },
  },
  required: ['text', 'status', 'kind'],
  additionalProperties: false,
};

export const GOAL_TOOL_DEFS = Object.freeze([
  {
    name: 'goal',
    title: 'Goal',
    description: 'Durable task list with an idle reminder for unfinished work. Use for 3+ steps or careful planning; skip trivial or conversational work. If a mutation needs approval, create the Goal only after it. Never spend an iteration on Goal alone: batch create/resume/set_tasks with the next work tool. Finish every approved step without stepwise approval. paused is the only user-wait state: mark work needing a user answer awaiting_approval (work that answer could invalidate counts too), keep doing the rest, pause once nothing can proceed and ask every parked question at once; never pause for routine errors, retries, or a user addition; resume right after the answer. Create with full tasks plus verification; complete only after auditing each user condition against current evidence, never by dropping one. Block only when the same external impasse stops progress for 3 turns, never for user input or a direction choice. Abandon only when the user redirects away from the objective.',
    annotations: {
      title: 'Goal',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      agentHidden: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'create', 'pause', 'resume', 'set_tasks', 'complete', 'block', 'abandon'],
          description: 'status reads; create starts approved execution; pause is the single user-wait state; resume continues it; set_tasks replaces the snapshot; complete or block finalizes; abandon discards a superseded Goal.',
        },
        objective: { type: 'string', description: 'create: requested task outcome.' },
        time_limit_minutes: {
          type: 'number',
          minimum: 1,
          maximum: MAX_GOAL_TIME_LIMIT_MS / 60_000,
          description: 'create: full-period active work commitment; do not complete early unless user allows it; omit unless requested.',
        },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_GOAL_TASKS,
          items: goalTaskSchema,
          description: 'create/set_tasks: full durable task snapshot.',
        },
        blocker: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_GOAL_BLOCKER_LENGTH,
          description: 'block: external impasse still preventing progress after 3 consecutive turns.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]);

function clean(value) {
  return String(value ?? '').trim();
}

const GOAL_ACTION_FIELDS = Object.freeze({
  status: ['action'],
  create: ['action', 'objective', 'time_limit_minutes'],
  pause: ['action'],
  resume: ['action'],
  set_tasks: ['action', 'tasks'],
  complete: ['action'],
  block: ['action', 'blocker'],
  abandon: ['action'],
});
const GOAL_TOOL_FIELDS = new Set(Object.values(GOAL_ACTION_FIELDS).flat());

function validateGoalToolCall(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('goal arguments must be an object');
  }
  const action = clean(value.action).toLowerCase();
  if (!action) throw new Error('goal action is required');
  const allowed = GOAL_ACTION_FIELDS[action];
  if (!allowed) throw new Error(`goal action must be one of: ${Object.keys(GOAL_ACTION_FIELDS).join(', ')}`);
  const extras = Object.keys(value).filter((key) => !GOAL_TOOL_FIELDS.has(key));
  if (extras.length > 0) throw new Error(`goal arguments contain unknown fields: ${extras.join(', ')}`);
  return action;
}

function assertSessionId(value) {
  const sessionId = clean(value);
  if (!SESSION_ID.test(sessionId)) throw new Error(`goal: invalid session id ${JSON.stringify(value)}`);
  return sessionId;
}

function validateObjective(value) {
  const objective = clean(value);
  if (!objective) throw new Error('goal objective is required');
  if ([...objective].length > MAX_OBJECTIVE_LENGTH) {
    throw new Error(`goal objective exceeds ${MAX_OBJECTIVE_LENGTH} characters`);
  }
  return objective;
}

function validateGoalTaskText(value) {
  const text = clean(value);
  if (!text) throw new Error('goal task text is required');
  if ([...text].length > MAX_GOAL_TASK_LENGTH) {
    throw new Error(`goal task exceeds ${MAX_GOAL_TASK_LENGTH} characters`);
  }
  return text;
}

function validateGoalBlocker(value) {
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

function durationLabel(milliseconds) {
  const totalMinutes = Math.max(0, Math.ceil(Number(milliseconds || 0) / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return [
    days ? `${days}d` : '',
    hours ? `${hours}h` : '',
    minutes || (!days && !hours) ? `${minutes}m` : '',
  ].filter(Boolean).join(' ');
}

function normalizeGoalTasks(input, previous = [], { strict = false } = {}) {
  if (input == null) return Array.isArray(previous) ? previous.map((task) => ({ ...task })) : [];
  if (!Array.isArray(input)) throw new Error('goal tasks must be an array');
  if (input.length > MAX_GOAL_TASKS) throw new Error(`goal tasks support at most ${MAX_GOAL_TASKS} entries`);
  const previousByText = new Map((Array.isArray(previous) ? previous : []).map((task) => [clean(task?.text), task]));
  const seen = new Set();
  const seenIds = new Set();
  return input.map((entry, index) => {
    const source = typeof entry === 'string' ? { text: entry, status: 'pending', kind: 'work' } : entry;
    if (!source || typeof source !== 'object') throw new Error(`goal task ${index + 1} is invalid`);
    const text = validateGoalTaskText(source.text);
    if (seen.has(text)) throw new Error(`duplicate goal task: ${text}`);
    seen.add(text);
    const previousEntry = previousByText.get(text);
    const id = clean(source.id) || clean(previousEntry?.id) || `task_${index + 1}`;
    if (seenIds.has(id)) throw new Error(`duplicate goal task id: ${id}`);
    seenIds.add(id);
    const legacySatisfied = source.satisfied === true;
    const rawStatus = clean(source.status).toLowerCase();
    if (strict && !GOAL_TASK_STATUSES.includes(rawStatus)) {
      throw new Error(`goal task ${index + 1} has an invalid status`);
    }
    const rawKind = clean(source.kind).toLowerCase();
    if (strict && !['work', 'verification'].includes(rawKind)) {
      throw new Error(`goal task ${index + 1} has an invalid kind`);
    }
    const status = GOAL_TASK_STATUSES.includes(rawStatus)
      ? rawStatus
      : legacySatisfied
        ? 'completed'
        : 'pending';
    return {
      id,
      text,
      status,
      kind: rawKind === 'verification' ? 'verification' : 'work',
    };
  });
}

function taskInputRetains(entry, task) {
  if (typeof entry === 'string') return clean(entry) === task.text;
  if (!entry || typeof entry !== 'object') return false;
  const id = clean(entry.id);
  return id ? id === task.id : clean(entry.text) === task.text;
}

function normalizeStoredGoal(value, sessionId, resumedAt = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  // Legacy files recorded the duration end as a spend cap. Map it explicitly:
  // falling through to 'active' would silently restart a Goal whose requested
  // duration had already elapsed.
  const storedStatus = value.status === 'budget_limited' ? 'duration_reached' : value.status;
  const status = GOAL_STATUS_VALUES.includes(storedStatus) ? storedStatus : 'active';
  const storedTimeLimitMs = Number(value.timeLimitMs);
  const timeLimitMs = Number.isFinite(storedTimeLimitMs) && storedTimeLimitMs > 0
    ? Math.min(MAX_GOAL_TIME_LIMIT_MS, Math.max(60_000, storedTimeLimitMs))
    : 0;
  const goal = {
    id: clean(value.id) || randomUUID(),
    sessionId,
    objective: validateObjective(value.objective),
    title: compactSessionTitle(value.title || value.objective),
    status,
    tasks: normalizeGoalTasks(value.tasks ?? value.criteria ?? []),
    blocker: clean(value.blocker),
    failureReason: clean(value.failureReason),
    failureCount: Math.max(0, Math.floor(Number(value.failureCount) || 0)),
    // Observations, never gates: how many turns this Goal has worked and when
    // its task list last actually changed. They make a spinning Goal visible
    // without any rule deciding on the user's behalf that it is stuck.
    turnCount: Math.max(0, Math.floor(Number(value.turnCount) || 0)),
    // Which turn last wrote off requested work. A drop is only honest when the
    // user changed the objective, so it must not also be the turn that ends the
    // Goal — otherwise the checklist can be tidied away and completed in one
    // breath, which is exactly how a user condition disappears unnoticed.
    lastDropTurn: Math.max(0, Math.floor(Number(value.lastDropTurn) || 0)),
    tasksUpdatedAt: Number(value.tasksUpdatedAt) > 0 ? Number(value.tasksUpdatedAt) : null,
    timeLimitMs,
    timeUsedMs: Math.max(0, Number(value.timeUsedMs) || 0),
    createdAt: Math.max(0, Number(value.createdAt) || Date.now()),
    updatedAt: Math.max(0, Number(value.updatedAt) || Date.now()),
    // Active is durable across process boundaries: preserve the open segment so
    // task updates, runtime eviction, and daemon restart never reset Goal time.
    lastStartedAt: status === 'active'
      ? Math.max(0, Number(value.lastStartedAt) || Number(resumedAt) || Date.now())
      : null,
    completedAt: Number(value.completedAt) > 0 ? Number(value.completedAt) : null,
    archivedAt: Number(value.archivedAt) > 0 ? Number(value.archivedAt) : null,
  };
  return goal;
}

function activeElapsedMs(goal, now = Date.now()) {
  const committed = Math.max(0, Number(goal?.timeUsedMs) || 0);
  if (goal?.status !== 'active' || !(Number(goal?.lastStartedAt) > 0)) return committed;
  return committed + Math.max(0, now - Number(goal.lastStartedAt));
}

function publicGoal(goal, now = Date.now()) {
  if (!goal) return null;
  const timeUsedMs = activeElapsedMs(goal, now);
  const hasTimeLimit = Number(goal.timeLimitMs) > 0;
  const remainingMs = hasTimeLimit
    ? Math.max(0, Number(goal.timeLimitMs) - timeUsedMs)
    : null;
  const tasks = normalizeGoalTasks(goal.tasks || []);
  return {
    id: goal.id,
    sessionId: goal.sessionId,
    objective: goal.objective,
    title: goal.title || compactSessionTitle(goal.objective),
    status: goal.status,
    tasks,
    turnCount: Math.max(0, Math.floor(Number(goal.turnCount) || 0)),
    tasksUpdatedAt: Number(goal.tasksUpdatedAt) > 0 ? Number(goal.tasksUpdatedAt) : null,
    tasksCompleted: tasks.filter((task) => task.status === 'completed').length,
    // Dropped rows stay in `tasks` for the record but leave the denominator,
    // so retiring work moves progress forward instead of freezing it.
    tasksTotal: tasks.filter((task) => task.status !== 'dropped').length,
    blocker: goal.blocker || '',
    timeLimitMs: goal.timeLimitMs,
    timeUsedMs,
    remainingMs,
    deadlineAt: hasTimeLimit && goal.status === 'active' && goal.lastStartedAt
      ? now + remainingMs
      : null,
    snapshotAt: now,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    lastStartedAt: goal.lastStartedAt,
    completedAt: goal.completedAt,
    archivedAt: goal.archivedAt,
  };
}

function normalizedCompletedGoalTtlMs(value) {
  const ttlMs = Number(value);
  return Number.isFinite(ttlMs) && ttlMs >= 0
    ? ttlMs
    : DEFAULT_COMPLETED_GOAL_TTL_MS;
}

function completedGoalExpired(goal, at, ttlMs = DEFAULT_COMPLETED_GOAL_TTL_MS) {
  if (goal?.status !== 'complete') return false;
  const completedAt = Number(goal.completedAt)
    || Number(goal.updatedAt)
    || Number(goal.createdAt)
    || 0;
  return completedAt > 0 && at - completedAt >= normalizedCompletedGoalTtlMs(ttlMs);
}

function goalFilePath(dataDir, sessionId) {
  return join(clean(dataDir) || process.cwd(), 'goals', `${assertSessionId(sessionId)}.json`);
}

function deleteStoredGoalFile(dataDir, sessionId) {
  try {
    rmSync(goalFilePath(dataDir, sessionId), { force: true });
    return true;
  } catch {
    return false;
  }
}

function stopActiveClock(goal, now = Date.now()) {
  if (goal.lastStartedAt) {
    goal.timeUsedMs = Math.max(0, Number(goal.timeUsedMs) || 0)
      + Math.max(0, now - Number(goal.lastStartedAt));
  }
  goal.lastStartedAt = null;
}

function checkpointActiveClock(goal, now = Date.now()) {
  if (!goal.lastStartedAt) return;
  goal.timeUsedMs = Math.max(0, Number(goal.timeUsedMs) || 0)
    + Math.max(0, now - Number(goal.lastStartedAt));
  goal.lastStartedAt = now;
}

function clearTurnFailures(goal) {
  goal.failureReason = '';
  goal.failureCount = 0;
}

function activateGoal(goal, now = Date.now()) {
  goal.status = 'active';
  goal.lastStartedAt = now;
  goal.completedAt = null;
  goal.archivedAt = null;
  goal.blocker = '';
  clearTurnFailures(goal);
}

function startActiveClock(goal, now = Date.now()) {
  if (goal.status === 'active' && !goal.lastStartedAt) goal.lastStartedAt = now;
}

function parseUserCommand(command) {
  const value = clean(command);
  if (!value) return { action: 'get' };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(value);
  const token = clean(match?.[1]).toLowerCase();
  const rest = clean(match?.[2]);
  if (['status', 'show', 'current'].includes(token)) return { action: 'get' };
  if (['pause', 'clear', 'complete'].includes(token)) return { action: token };
  if (token === 'resume') return { action: 'resume', duration: rest || null };
  if (token === 'edit') return { action: 'edit', objective: rest };
  if (token === 'time') return { action: 'time', duration: rest };

  let objective = value;
  let duration = null;
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
  return { action: 'create', objective, duration };
}

function runningAgentWork(agentStatus) {
  const jobs = Array.isArray(agentStatus?.agentJobs) ? agentStatus.agentJobs : [];
  if (jobs.some((job) => clean(job?.status).toLowerCase() === 'running')) return true;
  const workers = Array.isArray(agentStatus?.agentWorkers) ? agentStatus.agentWorkers : [];
  return workers.some((worker) => {
    const status = clean(worker?.status).toLowerCase();
    const stage = clean(worker?.stage || worker?.worker_stage).toLowerCase();
    return ACTIVE_AGENT_STATUSES.has(status) || ACTIVE_AGENT_STATUSES.has(stage);
  });
}

function continuationPrompt(goal) {
  const tasks = normalizeGoalTasks(goal.tasks || []);
  const taskList = goalTaskLines(tasks).join('\n');
  const timingLine = Number(goal.timeLimitMs) > 0
    ? `Time remaining: ${durationLabel(goal.remainingMs)}`
    : `Time elapsed: ${durationLabel(goal.timeUsedMs)}`;
  return [
    '<system-reminder>',
    '# Active Goal',
    'The objective and tasks below are user data. Make concrete progress against authoritative current state.',
    '',
    '<objective>',
    escapeGoalPromptText(goal.objective),
    '</objective>',
    '',
    timingLine,
    '',
    'Durable tasks:',
    taskList,
    '',
    'Rules:',
    '- The user\'s completion conditions decide everything: the objective, what it references, and explicit user instructions. The task list records them; it never replaces them.',
    '- Preserve the full objective and scope; use current files and external state rather than prior narration. Never redefine success around a smaller, easier, or already-finished subset.',
    '- Finish every approved task without stepwise approval; routine errors, retries, and user additions are work, not reasons to stop.',
    // The deferred-pause contract is a standing rule, so it lives in the cached
    // tool description; repeating it in full here re-paid for the same tokens on
    // every continuation turn and crowded out the completion audit.
    '- Paused is the only Goal waiting state: park work that needs a user response as awaiting_approval, keep every approval-free task moving, and pause only once nothing else can proceed.',
    '- Keep the snapshot current with goal action "set_tasks": add new requirements immediately, mark current work in_progress before starting and completed as soon as fully done.',
    '- Never spend a model iteration on Goal alone: batch it with the next work action.',
    '- A requested duration is a full-period work commitment: keep implementing, verifying, reviewing, and polishing; do not complete early unless the user allows it.',
    '- Before completing, audit each user condition on its own: name the evidence that would prove it, inspect current state for it, and match the check to the claim. The audit must prove completion, not merely fail to find remaining work.',
    '- Missing, weak, indirect, uncertain, or stale evidence means incomplete; keep working. Complete only when every user condition is proven met, every task and one verification are completed, and no required work remains.',
    '- Only the user retires a condition: drop a task because the user changed the objective, never to reach completion — a task dropped this turn blocks completion.',
    '- Block only when the same external impasse prevents meaningful progress for 3 consecutive Goal turns; never for user input, approval, direction choice, difficulty, uncertainty, or incomplete work.',
    '- Never complete or block merely because time is low or the turn is ending.',
    '</system-reminder>',
  ].join('\n');
}

function readStoredGoalFile(dataDir, sessionId, at = Date.now()) {
  const id = assertSessionId(sessionId);
  const path = goalFilePath(dataDir, id);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return normalizeStoredGoal(parsed?.goal, id, at);
  } catch {
    return null;
  }
}

export function readStoredGoalSnapshot({
  dataDir,
  sessionId,
  now = () => Date.now(),
  completedGoalTtlMs = DEFAULT_COMPLETED_GOAL_TTL_MS,
} = {}) {
  const at = Math.max(0, Number(now()) || Date.now());
  const goal = publicGoal(readStoredGoalFile(dataDir, sessionId, at), at);
  if (completedGoalExpired(goal, at, completedGoalTtlMs)) {
    deleteStoredGoalFile(dataDir, sessionId);
    return null;
  }
  return goal?.archivedAt ? null : goal;
}

export function listStoredActiveGoalSessionIds({
  dataDir,
  now = () => Date.now(),
  completedGoalTtlMs = DEFAULT_COMPLETED_GOAL_TTL_MS,
} = {}) {
  const root = join(clean(dataDir) || process.cwd(), 'goals');
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const at = Math.max(0, Number(now()) || Date.now());
  const sessionIds = [];
  for (const entry of entries) {
    if (!entry?.isFile?.() || !entry.name.endsWith('.json')) continue;
    const sessionId = entry.name.slice(0, -'.json'.length);
    if (!SESSION_ID.test(sessionId)) continue;
    const goal = publicGoal(readStoredGoalFile(dataDir, sessionId, at), at);
    if (completedGoalExpired(goal, at, completedGoalTtlMs)) {
      deleteStoredGoalFile(dataDir, sessionId);
      continue;
    }
    if (goal?.status === 'active' && !goal.archivedAt) sessionIds.push(sessionId);
  }
  return sessionIds.sort();
}

export function createGoalRuntime({
  dataDir,
  now = () => Date.now(),
  defaultTimeLimitMs = DEFAULT_GOAL_TIME_LIMIT_MS,
  completedGoalTtlMs = DEFAULT_COMPLETED_GOAL_TTL_MS,
  generateTitle = null,
} = {}) {
  const root = join(clean(dataDir) || process.cwd(), 'goals');
  const completedRetentionMs = normalizedCompletedGoalTtlMs(completedGoalTtlMs);
  const cache = new Map();
  const listeners = new Set();
  const deadlineTimers = new Map();
  const writeChains = new Map();
  const mutationChains = new Map();
  const turnGoalIds = new Map();
  const turnStartedAt = new Map();
  const titleJobs = new Map();
  let closed = false;

  const pathFor = (sessionId) => join(root, `${assertSessionId(sessionId)}.json`);

  const readRecord = (sessionId, force = false) => {
    const id = assertSessionId(sessionId);
    const path = pathFor(id);
    let mtimeMs = 0;
    try { mtimeMs = statSync(path).mtimeMs || 0; } catch {}
    const cached = cache.get(id);
    if (!force && cached && (writeChains.has(id) || cached.mtimeMs === mtimeMs)) return cached.record;
    let record = { version: GOAL_FILE_VERSION, goal: null };
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        record = {
          version: GOAL_FILE_VERSION,
          goal: normalizeStoredGoal(parsed?.goal, id, now()),
        };
      }
    } catch {
      record = { version: GOAL_FILE_VERSION, goal: null };
    }
    cache.set(id, { record, mtimeMs });
    return record;
  };

  const persist = (sessionId, record) => {
    const id = assertSessionId(sessionId);
    const previous = writeChains.get(id) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      await writeJsonAtomicAsync(pathFor(id), record, {
        lock: true,
        secret: true,
        fsync: false,
        timeoutMs: 2_000,
      });
      let mtimeMs = Date.now();
      try { mtimeMs = statSync(pathFor(id)).mtimeMs || mtimeMs; } catch {}
      const cached = cache.get(id);
      if (cached?.record === record) cache.set(id, { record, mtimeMs });
    });
    writeChains.set(id, write);
    write.finally(() => {
      if (writeChains.get(id) === write) writeChains.delete(id);
    }).catch(() => {});
    return write;
  };

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

  const clearDeadline = (sessionId) => {
    const timer = deadlineTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    deadlineTimers.delete(sessionId);
  };

  const commit = async (sessionId, goal) => {
    const id = assertSessionId(sessionId);
    const committedGoal = goal
      ? {
        ...goal,
        sessionId: id,
        tasks: Array.isArray(goal.tasks)
          ? goal.tasks.map((task) => ({ ...task }))
          : [],
      }
      : null;
    const record = { version: GOAL_FILE_VERSION, goal: committedGoal };
    cache.set(id, { record, mtimeMs: cache.get(id)?.mtimeMs || 0 });
    armDeadline(id);
    emit(id);
    await persist(id, record);
    return publicGoal(committedGoal, now());
  };

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
      Promise.resolve().then(() => generateTitle(objective, { signal: abort.signal })),
      timeout,
    ]).then((rawTitle) => {
      if (closed || abort.signal.aborted || titleJobs.get(id) !== job) return;
      const title = compactSessionTitle(rawTitle);
      if (!title || title === goal.title) return;
      return withMutation(id, async () => {
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

  const limitIfExpired = (sessionId) => {
    const id = assertSessionId(sessionId);
    const record = readRecord(id);
    const goal = record.goal;
    if (!goal || goal.status !== 'active' || !(Number(goal.timeLimitMs) > 0)) return false;
    const at = now();
    if (activeElapsedMs(goal, at) < goal.timeLimitMs) return false;
    stopActiveClock(goal, at);
    goal.status = 'duration_reached';
    goal.timeUsedMs = Math.max(goal.timeUsedMs, goal.timeLimitMs);
    goal.updatedAt = at;
    void commit(id, goal).catch(() => {});
    return true;
  };

  function armDeadline(sessionId) {
    clearDeadline(sessionId);
    const goal = readRecord(sessionId).goal;
    if (!goal || goal.status !== 'active' || !goal.lastStartedAt || !(Number(goal.timeLimitMs) > 0)) return;
    const remainingMs = Math.max(0, goal.timeLimitMs - activeElapsedMs(goal, now()));
    if (remainingMs <= 0) {
      queueMicrotask(() => limitIfExpired(sessionId));
      return;
    }
    const timer = setTimeout(() => {
      deadlineTimers.delete(sessionId);
      void withMutation(sessionId, () => limitIfExpired(sessionId)).catch(() => {});
    }, remainingMs);
    timer.unref?.();
    deadlineTimers.set(sessionId, timer);
  }

  const storedSnapshot = (sessionId) => {
    const id = assertSessionId(sessionId);
    limitIfExpired(id);
    const at = now();
    const goal = publicGoal(readRecord(id).goal, at);
    if (!completedGoalExpired(goal, at, completedRetentionMs)) return goal;
    clearDeadline(id);
    cache.set(id, {
      record: { version: GOAL_FILE_VERSION, goal: null },
      mtimeMs: 0,
    });
    deleteStoredGoalFile(dataDir, id);
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
    if (record.goal && !['complete'].includes(record.goal.status)) {
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
      sessionId: id,
      objective: validateObjective(args.objective),
      title: compactSessionTitle(args.objective),
      status: 'active',
      tasks: initialTasks,
      blocker: '',
      failureReason: '',
      failureCount: 0,
      turnCount: 0,
      lastDropTurn: 0,
      tasksUpdatedAt: initialTasks.length > 0 ? at : null,
      timeLimitMs,
      timeUsedMs: 0,
      createdAt: at,
      updatedAt: at,
      lastStartedAt: at,
      completedAt: null,
      archivedAt: null,
    };
    if (args.startInCurrentTurn === true) {
      const startedAt = turnStartedAt.get(id) || at;
      turnGoalIds.set(id, goal.id);
      turnStartedAt.set(id, startedAt);
      goal.lastStartedAt = startedAt;
    }
    const created = await commit(id, goal);
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
    if (!status) throw new Error('update_goal status is required');
    if (!['active', 'complete', 'blocked'].includes(status)) {
      throw new Error('update_goal can only set status active, complete, or blocked');
    }
    if (status === 'active') {
      if (goal.status === 'complete') {
        throw new Error('a completed Goal cannot be resumed; edit it or create a new Goal');
      }
      if (goal.status !== 'active') activateGoal(goal, at);
      else {
        goal.blocker = '';
        clearTurnFailures(goal);
      }
    } else if (status === 'complete') {
      // Evidence gates the MODEL's completion claim, never the user's. A user
      // completing their own Goal is an act of authority: without this the
      // only user-side exit was deleting the Goal, which threw the record
      // away. Unfinished rows stay unfinished so the record stays honest.
      if (!user) {
        const tasks = normalizeGoalTasks(goal.tasks || []);
        if (tasks.length === 0) {
          throw new Error('cannot complete Goal: create at least one durable task first');
        }
        const incomplete = tasks.filter((task) => !GOAL_TASK_SETTLED.includes(task.status));
        if (incomplete.length > 0) {
          throw new Error(`cannot complete Goal: ${incomplete.length} durable tasks remain incomplete`);
        }
        if (!tasks.some((task) => task.kind === 'verification' && task.status === 'completed')) {
          throw new Error('cannot complete Goal: complete at least one verification task first');
        }
        const turnCount = Math.max(0, Math.floor(Number(goal.turnCount) || 0));
        if (turnCount > 0 && Math.max(0, Math.floor(Number(goal.lastDropTurn) || 0)) === turnCount) {
          throw new Error(
            'cannot complete Goal: a task was dropped this turn; only a user scope change retires '
            + 'requested work, so finish that work or let the user confirm the change first',
          );
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
      if (turnGoalIds.get(id) === goal.id) checkpointActiveClock(goal, at);
      else stopActiveClock(goal, at);
      goal.status = 'blocked';
      goal.blocker = blocker;
      clearTurnFailures(goal);
    }
    goal.updatedAt = at;
    return commit(id, goal);
  };

  const setGoalTasks = async (sessionId, args = {}, { expectedGoalId = '' } = {}) => {
    const id = assertSessionId(sessionId);
    const goal = requireGoal(id);
    if (clean(expectedGoalId) && clean(expectedGoalId) !== clean(goal.id)) {
      throw new Error('stale Goal task update rejected because the active Goal changed');
    }
    if (goal.status === 'complete') {
      throw new Error('cannot update tasks for a completed Goal');
    }
    if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
      throw new Error('goal set_tasks requires at least one task');
    }
    const previousTasks = normalizeGoalTasks(goal.tasks || []);
    const omitted = previousTasks.filter((task) =>
      !GOAL_TASK_SETTLED.includes(task.status)
      && !args.tasks.some((entry) => taskInputRetains(entry, task)));
    if (omitted.length > 0) {
      const detail = omitted.map((task) => `${task.id} (${task.text})`).join(', ');
      throw new Error(`cannot remove unfinished Goal tasks: ${detail}`);
    }
    const nextTasks = normalizeGoalTasks(args.tasks, previousTasks, { strict: true });
    const at = now();
    // Only a real change counts as movement: re-sending an identical snapshot
    // must not read as progress on the observation line.
    if (JSON.stringify(nextTasks) !== JSON.stringify(previousTasks)) goal.tasksUpdatedAt = at;
    // Stamp the turn that retired requested work so completion cannot ride on a
    // last-breath write-off: the drop has to survive into a later turn, where it
    // is visible to the user before the Goal can close.
    const droppedNow = nextTasks.some((task) => task.status === 'dropped'
      && previousTasks.find((prev) => prev.id === task.id)?.status !== 'dropped');
    if (droppedNow) goal.lastDropTurn = Math.max(0, Math.floor(Number(goal.turnCount) || 0));
    goal.tasks = nextTasks;
    goal.updatedAt = at;
    return commit(id, goal);
  };

  // Explicit retirement of a superseded Goal. The create guard stays strict so
  // parallel Goals stay impossible; this is the one way out of it, and it is
  // deliberately an act the model has to take rather than a silent overwrite.
  const abandonGoal = async (sessionId, { expectedGoalId = '' } = {}) => {
    const id = assertSessionId(sessionId);
    const goal = requireGoal(id);
    if (clean(expectedGoalId) && clean(expectedGoalId) !== clean(goal.id)) {
      throw new Error('stale Goal abandon rejected because the active Goal changed');
    }
    clearDeadline(id);
    turnGoalIds.delete(id);
    await commit(id, null);
    return null;
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
    const at = now();
    if (action === 'pause') {
      if (goal.status === 'active') stopActiveClock(goal, at);
      goal.status = 'paused';
      goal.blocker = '';
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
      stopActiveClock(goal, at);
      if (added != null) goal.timeLimitMs = Math.min(MAX_GOAL_TIME_LIMIT_MS, goal.timeUsedMs + added);
      if (goal.timeLimitMs > 0 && goal.timeLimitMs <= goal.timeUsedMs) goal.timeLimitMs = 0;
      activateGoal(goal, at);
      goal.updatedAt = at;
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
      goal.objective = validateObjective(args.objective);
      goal.title = compactSessionTitle(goal.objective);
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

  const executeTool = async (name, args = {}, context = {}) => {
    const sessionId = context.callerSessionId || context.sessionId;
    const id = assertSessionId(sessionId);
    if (name === 'goal') {
      const action = validateGoalToolCall(args);
      if (action === 'status') {
        // Same view the user sees. Reading the stored record here showed the
        // model Goals the user had already archived away.
        const goal = visibleSnapshot(id);
        return JSON.stringify({ goal, remaining_ms: goal?.remainingMs ?? null });
      }
      if (action === 'create') {
        let timeLimitMs;
        if (Object.hasOwn(args, 'time_limit_minutes')) {
          const minutes = Number(args.time_limit_minutes);
          if (!Number.isFinite(minutes) || minutes <= 0) {
            throw new Error('goal time_limit_minutes must be a positive number');
          }
          timeLimitMs = minutes * 60_000;
        }
        const goal = await withMutation(id, () => createGoal(id, {
          objective: args.objective,
          tasks: args.tasks,
          startInCurrentTurn: true,
          ...(timeLimitMs != null ? { timeLimitMs } : {}),
        }));
        return JSON.stringify({ goal, remaining_ms: goal.remainingMs });
      }
      const expectedGoalId = turnGoalIds.get(id) || storedSnapshot(id)?.id || '';
      if (action === 'abandon') {
        await withMutation(id, () => abandonGoal(id, { expectedGoalId }));
        return JSON.stringify({ goal: null, remaining_ms: null });
      }
      if (action === 'pause' || action === 'resume') {
        const result = await withMutation(id, () => control(id, { action, expectedGoalId }));
        return JSON.stringify({ goal: result.goal, remaining_ms: result.goal.remainingMs });
      }
      if (action === 'set_tasks') {
        const goal = await withMutation(id, () => setGoalTasks(id, args, { expectedGoalId }));
        return JSON.stringify({ goal, remaining_ms: goal.remainingMs });
      }
      const goal = await withMutation(id, () => updateGoal(id, {
        status: action === 'block' ? 'blocked' : 'complete',
        ...(action === 'block' ? { blocker: args.blocker } : {}),
      }, { expectedGoalId }));
      return JSON.stringify({ goal, remaining_ms: goal.remainingMs });
    }
    // Runtime-only compatibility for in-flight calls from pre-unification sessions.
    if (name === 'get_goal') {
      const goal = visibleSnapshot(id);
      return JSON.stringify({ goal, remaining_ms: goal?.remainingMs ?? null });
    }
    if (name === 'create_goal') {
      const minutes = Number(args.time_limit_minutes);
      const goal = await withMutation(id, () => createGoal(id, {
          objective: args.objective,
          ...(Number.isFinite(minutes) && minutes > 0 ? { timeLimitMs: minutes * 60_000 } : {}),
        }));
      return JSON.stringify({ goal, remaining_ms: goal.remainingMs });
    }
    if (name === 'update_goal') {
      const expectedGoalId = turnGoalIds.get(id) || storedSnapshot(id)?.id || '';
      const goal = await withMutation(id, () => updateGoal(id, args, { expectedGoalId }));
      return JSON.stringify({ goal, remaining_ms: goal.remainingMs });
    }
    if (name === 'set_goal_tasks') {
      const expectedGoalId = turnGoalIds.get(id) || storedSnapshot(id)?.id || '';
      const goal = await withMutation(id, () => setGoalTasks(id, args, { expectedGoalId }));
      return JSON.stringify({ goal, remaining_ms: goal.remainingMs });
    }
    throw new Error(`unknown Goal tool: ${name}`);
  };

  return {
    tools: GOAL_TOOL_DEFS,
    snapshot(sessionId) {
      const goal = visibleSnapshot(sessionId);
      armDeadline(sessionId);
      return goal;
    },
    storedSnapshot,
    watchSession(sessionId) {
      if (!sessionId) return null;
      const goal = visibleSnapshot(sessionId);
      armDeadline(sessionId);
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
          goal.blocker = '';
        } else if (status === 'failed' && goal.status === 'active') {
          const failureReason = clean(detail?.error) || 'Goal turn failed';
          if (goal.failureReason === failureReason) goal.failureCount += 1;
          else {
            goal.failureReason = failureReason;
            goal.failureCount = 1;
          }
          goal.blocker = '';
          if (goal.failureCount >= 3) {
            stopActiveClock(goal, at);
            goal.status = 'blocked';
            goal.blocker = failureReason;
          }
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
      return { run: true, reason: 'idle', goal, prompt: continuationPrompt(goal) };
    },
    async archiveCompletedOnUserInput(sessionId) {
      if (!sessionId) return null;
      return withMutation(sessionId, async (id) => {
        const goal = readRecord(id).goal;
        if (!goal || goal.status !== 'complete' || goal.archivedAt) return visibleSnapshot(id);
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
      for (const timer of deadlineTimers.values()) clearTimeout(timer);
      deadlineTimers.clear();
      mutationChains.clear();
      turnGoalIds.clear();
      turnStartedAt.clear();
      listeners.clear();
    },
  };
}
