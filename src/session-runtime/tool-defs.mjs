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
  description: 'Load named deferred tools and report activation status. Direct calls auto-load, so no pre-call is needed.',
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
  description: 'Load a named SKILL.md into context.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact name from available-skills.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

export const LEAD_DISALLOWED_TOOLS = Object.freeze([]);
const AGENT_HIDDEN_WRAPPER_TOOLS = new Set([]);

export function applyStandaloneToolDefaults(tool) {
  if (!tool || !AGENT_HIDDEN_WRAPPER_TOOLS.has(tool.name)) return tool;
  return {
    ...tool,
    annotations: {
      ...(tool.annotations || {}),
      agentHidden: true,
    },
  };
}
