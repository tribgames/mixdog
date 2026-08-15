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
  description: 'Deferred-tool activation status; direct calls auto-load — no pre-call needed.',
  inputSchema: {
    type: 'object',
    properties: {
      names: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Exact deferred tool names/aliases to load.' },
    },
    additionalProperties: false,
  },
};

export const CWD_TOOL = {
  name: 'cwd',
  title: 'Work Project',
  annotations: {
    title: 'Work Project',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    agentHidden: true,
  },
  description: 'Show or set the session work project for tool execution. Session Cwd is already active; set only to change it.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'], description: 'Default get.' },
      path: { type: 'string', description: 'Project directory for set.' },
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
      name: { type: 'string', description: 'Skill name.' },
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
