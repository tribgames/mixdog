export const MAX_GOAL_TIME_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
export const GOAL_TASK_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'completed',
  'dropped',
  'awaiting_approval',
]);
export const GOAL_TASK_SETTLED = Object.freeze(['completed', 'dropped']);
export const MAX_GOAL_TASKS = 20;
export const MAX_GOAL_TASK_TEXT_LENGTH = 500;

const taskFields = {
  id: { type: 'string', description: 'Stable task id; omit only for new tasks.' },
  text: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_GOAL_TASK_TEXT_LENGTH,
    description: 'Required work or verification outcome.',
  },
  status: {
    type: 'string',
    enum: GOAL_TASK_STATUSES,
    description:
      'completed only when fully done; dropped only after user scope change; awaiting_approval for user-dependent work.',
  },
};

export const GOAL_TOOL_DEFS = Object.freeze([
  {
    name: 'goal',
    title: 'Goal',
    description: [
      'Durable tasks with an idle reminder for unfinished work. Create for an explicit Goal request, or approved work spanning several rounds or turns: staged refactors and migrations, repeated improvement passes, open-ended objectives that must be finished, with or without a time budget. Single-turn tasks, planning or estimates alone, and unaccepted proposals do not qualify.',
      'Obtain required approval, load the goal-management skill for lifecycle and completion policy, then create or reconcile the Goal before starting approved work. Mutations need the latest revision.',
    ].join(' '),
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
          enum: ['status', 'create', 'pause', 'resume', 'set_tasks', 'update_tasks', 'complete', 'block', 'abandon'],
          description:
            'create starts approved work once any previous Goal has ended; resume continues unfinished work with optional time and task changes; set_tasks replaces, update_tasks patches/adds; pause waits for a user answer; abandon retires superseded work.',
        },
        objective: { type: 'string', description: 'create: requested outcome.' },
        time_limit_minutes: {
          type: 'number',
          minimum: 1,
          maximum: MAX_GOAL_TIME_LIMIT_MS / 60_000,
          description:
            'create: approved total budget, omitted when none was agreed. resume: approved remaining budget from now, keeping time already used; another 5-hour round sets 300. Omit to preserve the current budget.',
        },
        time_mode: {
          type: 'string',
          enum: ['max', 'duration'],
          description:
            'max permits verified early completion; duration commits the full period, only on explicit request. Omitted: create defaults to max, resume keeps the current mode. Change a mode only with user approval.',
        },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_GOAL_TASKS,
          items: {
            type: 'object',
            properties: taskFields,
            required: ['text', 'status'],
            additionalProperties: false,
          },
          description: `create/set_tasks: full list; update_tasks/resume: new tasks, no ids. Max ${MAX_GOAL_TASKS} total, including completed/dropped.`,
        },
        updates: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_GOAL_TASKS,
          items: { type: 'object', properties: taskFields, required: ['id'], additionalProperties: false },
          description: 'update_tasks/resume: existing task ids with only changed fields.',
        },
        revision: {
          type: 'integer',
          minimum: 1,
          description: 'Latest Goal revision from a result or reminder; use for mutations other than create.',
        },
        blocker: {
          type: 'string',
          minLength: 1,
          maxLength: 1_000,
          description:
            'pause: the required user answer. block: stable description of the same external impasse, reported once per turn; the runtime stops after 3.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]);

const ACTION_FIELDS = Object.freeze({
  status: ['action'],
  create: ['action', 'objective', 'time_limit_minutes', 'time_mode', 'tasks'],
  pause: ['action', 'revision', 'blocker'],
  resume: ['action', 'time_limit_minutes', 'time_mode', 'tasks', 'updates', 'revision'],
  set_tasks: ['action', 'tasks', 'revision'],
  update_tasks: ['action', 'tasks', 'updates', 'revision'],
  complete: ['action', 'revision'],
  block: ['action', 'blocker', 'revision'],
  abandon: ['action', 'revision'],
});
const TOOL_FIELDS = new Set(Object.values(ACTION_FIELDS).flat());

export function validateGoalToolCall(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('goal arguments must be an object');
  const action = String(value.action ?? '')
    .trim()
    .toLowerCase();
  if (!action) throw new Error('goal action is required');
  if (!ACTION_FIELDS[action]) throw new Error(`goal action must be one of: ${Object.keys(ACTION_FIELDS).join(', ')}`);
  const extras = Object.keys(value).filter((key) => !TOOL_FIELDS.has(key));
  if (extras.length) throw new Error(`goal arguments contain unknown fields: ${extras.join(', ')}`);
  // Restored providers can fill every optional field. Consume only the active
  // action's payload; an absent/empty revision keeps old frozen schemas usable.
  if (ACTION_FIELDS[action].includes('revision') && value.revision != null && value.revision !== '') {
    if (!Number.isSafeInteger(value.revision) || value.revision < 1)
      throw new Error('goal revision must be a positive integer');
  }
  return action;
}
