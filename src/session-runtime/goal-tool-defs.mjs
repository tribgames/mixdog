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
    'Durable tasks with an idle reminder for unfinished work. Use for 3+ steps or careful planning; skip trivial or conversational work. If a mutation needs approval, create the Goal only after it.',
    'Keep tasks current: capture new requirements immediately, mark work in_progress before starting and completed as soon as fully done; update changed plans before continuing or reporting.',
    'Prefer update_tasks for changed items; set_tasks replaces the full list. Use the latest revision for mutations; on a stale conflict, read status and reconcile, never blindly replay. Full state returns on create/status/resume; other replies are brief.',
    'When possible, batch updates with independent work; standalone updates are allowed and must not be delayed for batching.',
    'Finish every approved step. Record additions immediately, but park new approval-dependent work and anything it could invalidate as awaiting_approval; continue unaffected approved work. paused is the only user-wait state: pause only when nothing else can proceed, ask all parked questions together, and call resume alongside resumed work. Routine errors and retries are not reasons to pause.',
    'Create with full tasks plus verification. Complete only after auditing every user condition against evidence. A requested duration is a full-period commitment; only explicit user completion can end it early. Block only when the same external impasse stops progress for 3 turns, never for user input or direction. Abandon only when the user redirects away from the objective.',
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
        description: 'status reads; create starts approved work; pause waits for user; resume accompanies resumed work; set_tasks replaces; update_tasks patches/adds; complete/block finish; abandon retires superseded work.',
      },
      objective: { type: 'string', description: 'create: requested outcome.' },
      time_limit_minutes: {
        type: 'number', minimum: 1, maximum: MAX_GOAL_TIME_LIMIT_MS / 60_000,
        description: 'create only: full-period work commitment; omit unless user requested a duration.',
      },
      tasks: {
        type: 'array', minItems: 1, maxItems: MAX_GOAL_TASKS,
        items: { type: 'object', properties: taskFields, required: ['text', 'status', 'kind'], additionalProperties: false },
        description: 'create/set_tasks: full list; update_tasks: new tasks to append, without ids.',
      },
      updates: {
        type: 'array', minItems: 1, maxItems: MAX_GOAL_TASKS,
        items: { type: 'object', properties: taskFields, required: ['id'], additionalProperties: false },
        description: 'update_tasks: existing task ids with only changed fields.',
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
  resume: ['action', 'revision'],
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
