export const MAX_GOAL_TIME_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
export const GOAL_TASK_STATUSES = Object.freeze([
  'pending', 'in_progress', 'completed', 'dropped', 'awaiting_approval',
]);
export const GOAL_TASK_SETTLED = Object.freeze(['completed', 'dropped']);
export const MAX_GOAL_TASKS = 20;

const taskFields = {
  id: { type: 'string', description: 'Stable task id; omit only for new tasks.' },
  text: { type: 'string', description: 'Required work or verification outcome.' },
  status: {
    type: 'string',
    enum: GOAL_TASK_STATUSES,
    description: 'completed only when fully done; dropped only after user scope change; awaiting_approval for user-dependent work.',
  },
  kind: { type: 'string', enum: ['work', 'verification'] },
};

export const GOAL_TOOL_DEFS = Object.freeze([{
  name: 'goal',
  title: 'Goal',
  description: [
    'Durable tasks with an idle reminder for unfinished work. Goal creation requires an explicit request from the user or system/developer instructions. Ordinary tasks, complexity, or planning needs do not imply a Goal request. If a mutation needs approval, create the Goal only after it.',
    'Load the goal-management skill for task lifecycle and completion policy. Mutations require the latest revision; reconcile stale conflicts rather than blindly replaying.',
  ].join(' '),
  annotations: {
    title: 'Goal', readOnlyHint: false, destructiveHint: false,
    idempotentHint: false, openWorldHint: false, agentHidden: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'create', 'pause', 'resume', 'set_tasks', 'update_tasks', 'complete', 'block', 'abandon'],
        description: 'status reads; create starts approved work; pause waits for user; resume accompanies resumed work with optional task changes; set_tasks replaces; update_tasks patches/adds; complete/block finish; abandon retires superseded work.',
      },
      objective: { type: 'string', description: 'create: requested outcome.' },
      time_limit_minutes: {
        type: 'number', minimum: 1, maximum: MAX_GOAL_TIME_LIMIT_MS / 60_000,
        description: 'create only: full-period work commitment; omit unless user requested a duration.',
      },
      tasks: {
        type: 'array', minItems: 1, maxItems: MAX_GOAL_TASKS,
        items: { type: 'object', properties: taskFields, required: ['text', 'status', 'kind'], additionalProperties: false },
        description: 'create/set_tasks: full list; update_tasks/resume: new tasks to append, without ids.',
      },
      updates: {
        type: 'array', minItems: 1, maxItems: MAX_GOAL_TASKS,
        items: { type: 'object', properties: taskFields, required: ['id'], additionalProperties: false },
        description: 'update_tasks/resume: existing task ids with only changed fields.',
      },
      revision: { type: 'integer', minimum: 1, description: 'Latest Goal revision from a result or reminder; use for mutations other than create.' },
      blocker: { type: 'string', minLength: 1, maxLength: 1_000, description: 'block: external impasse preventing progress for 3 consecutive turns.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
}]);

const ACTION_FIELDS = Object.freeze({
  status: ['action'],
  create: ['action', 'objective', 'time_limit_minutes', 'tasks'],
  pause: ['action', 'revision'],
  resume: ['action', 'tasks', 'updates', 'revision'],
  set_tasks: ['action', 'tasks', 'revision'],
  update_tasks: ['action', 'tasks', 'updates', 'revision'],
  complete: ['action', 'revision'],
  block: ['action', 'blocker', 'revision'],
  abandon: ['action', 'revision'],
});
const TOOL_FIELDS = new Set(Object.values(ACTION_FIELDS).flat());

export function validateGoalToolCall(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('goal arguments must be an object');
  const action = String(value.action ?? '').trim().toLowerCase();
  if (!action) throw new Error('goal action is required');
  if (!ACTION_FIELDS[action]) throw new Error(`goal action must be one of: ${Object.keys(ACTION_FIELDS).join(', ')}`);
  const extras = Object.keys(value).filter((key) => !TOOL_FIELDS.has(key));
  if (extras.length) throw new Error(`goal arguments contain unknown fields: ${extras.join(', ')}`);
  // Restored providers can fill every optional field. Consume only the active
  // action's payload; an absent/empty revision keeps old frozen schemas usable.
  if (ACTION_FIELDS[action].includes('revision') && value.revision != null && value.revision !== '') {
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('goal revision must be a positive integer');
  }
  return action;
}
