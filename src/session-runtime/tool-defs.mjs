// Standalone session tool definitions (wrapper tools surfaced by the runtime).
// Pure, self-contained schemas + the agent-hidden default helper. Extracted
// from mixdog-session-runtime.mjs; no runtime closure dependencies.

export const TOOL_SEARCH_TOOL = {
  name: 'load_tool',
  title: 'load_tool',
  annotations: {
    title: 'load_tool',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    agentHidden: true,
  },
  description: 'Load full schemas for exact deferred tool names/aliases not already available; returns function descriptions and parameter schemas.',
  inputSchema: {
    type: 'object',
    properties: {
      names: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Exact deferred tool names/aliases to load.' },
    },
    required: ['names'],
    additionalProperties: false,
  },
};

export const CWD_TOOL = {
  name: 'cwd',
  title: 'Project',
  annotations: {
    title: 'Project',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    agentHidden: true,
  },
  description: 'Show the active Project, or set it to path. A shell-local cd does not change the Project.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'New Project directory. Omit to show the active Project.' },
    },
    additionalProperties: false,
  },
};

export const SKILL_TOOL = {
  name: 'Skill',
  title: 'Skill',
  annotations: {
    title: 'Skill',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    agentHidden: false,
  },
  description: 'Load or refresh an available skill’s SKILL.md before task actions when its body is missing or needs an update. Reuse a body already in context for matching requests; a later turn or repeated mention is not a reason to call Skill again.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact name from available-skills.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

export const LEAD_DISALLOWED_TOOLS = Object.freeze([
  'get_goal',
  'create_goal',
  'set_goal_tasks',
  'update_goal',
]);
