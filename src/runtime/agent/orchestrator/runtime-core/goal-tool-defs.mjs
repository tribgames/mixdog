export const MAX_GOAL_TIME_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
export const GOAL_TOOL_ACTIONS = Object.freeze(['status', 'create', 'complete', 'block', 'extend']);

export const GOAL_TOOL_DEFS = Object.freeze([
  {
    name: 'goal',
    title: 'Goal',
    description:
      'A durable objective the runtime keeps working on across turns until you complete or block it, with an optional time cap (an upper bound, never a minimum). Create one only for an explicit Goal request or approved multi-turn work (staged refactors, migrations, open-ended objectives); never for single-turn tasks, plans, estimates or unaccepted proposals. One Goal at a time; its steps live in todo, not here. complete only after auditing every user condition against current evidence — never because time is low, the cap was reached or the turn is ending, and never for a smaller objective than the one stated. block only when the same blocking condition has recurred for at least three consecutive Goal turns (first turn and continuations count) and no progress is possible without the user or a change in external state; never because the work is hard, slow, uncertain, unfinished or would benefit from clarification. A resumed Goal counts afresh; once the threshold is met, block rather than report the impasse. extend adds minutes to an active or paused Goal’s time cap, only when the user explicitly asks in this conversation; never on your own initiative. Pause, resume, stop and other edits are the user’s controls.',
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
          enum: GOAL_TOOL_ACTIONS,
          description: 'create starts approved work once any previous Goal has ended.',
        },
        objective: { type: 'string', description: 'create: the requested outcome, as the user stated it.' },
        time_limit_minutes: {
          type: 'number',
          minimum: 1,
          maximum: MAX_GOAL_TIME_LIMIT_MS / 60_000,
          description: 'create: agreed time cap; omit when none was agreed.',
        },
        extend_minutes: {
          type: 'number',
          minimum: 1,
          maximum: MAX_GOAL_TIME_LIMIT_MS / 60_000,
          description: 'extend: minutes to add to the cap.',
        },
        blocker: {
          type: 'string',
          minLength: 1,
          maxLength: 1_000,
          description: 'block: the impasse that recurred for three consecutive Goal turns; stops the Goal.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]);

const ACTION_FIELDS = Object.freeze({
  status: ['action'],
  create: ['action', 'objective', 'time_limit_minutes'],
  complete: ['action'],
  block: ['action', 'blocker'],
  extend: ['action', 'extend_minutes'],
});
const TOOL_FIELDS = new Set(Object.values(ACTION_FIELDS).flat());
// Fields of the retired task/revision schema a restored provider may still
// fill from a frozen tool list; they carry nothing now and are ignored.
const RETIRED_FIELDS = new Set(['tasks', 'updates', 'revision', 'time_mode']);

export function validateGoalToolCall(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('goal arguments must be an object');
  const action = String(value.action ?? '')
    .trim()
    .toLowerCase();
  if (!action) throw new Error('goal action is required');
  if (!ACTION_FIELDS[action]) throw new Error(`goal action must be one of: ${Object.keys(ACTION_FIELDS).join(', ')}`);
  const extras = Object.keys(value).filter((key) => !TOOL_FIELDS.has(key) && !RETIRED_FIELDS.has(key));
  if (extras.length) {
    throw new Error(
      `goal arguments contain unknown fields: ${extras.join(', ')}. Allowed for ${action}: ${ACTION_FIELDS[action].join(', ')}`
    );
  }
  return action;
}
