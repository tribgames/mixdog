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
  description: 'load_tool: pure loader for deferred tools. Pass names:["exact_tool_name", ...] (deferred tool names/aliases) to load them; returns loaded / already-active / missing plus any MCP servers still connecting (retry next turn) or failed. No keyword search, no ranking, no listing. Deferred tools can also be called directly by name (they auto-load on first call).',
  inputSchema: {
    type: 'object',
    properties: {
      names: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Exact deferred tool names/aliases to load.' },
      select: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Legacy alias for names (accepts "select:a,b").' },
      query: { type: 'string', description: 'Legacy: only "select:a,b" is honored (mapped to names); free-text keyword queries are rejected — this tool does not search.' },
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
  description: 'Show or set the session work project for tool execution. Use only for explicit project path changes.',
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

// Owner-directed session reset tool. `clear` mirrors /clear (full wipe);
// `compact_clear` mirrors the auto-clear path (summarize via the configured
// compactType, then reset — context carries forward in the summary). The
// reset is SCHEDULED: it runs when the current turn ends, never mid-turn,
// because the live transcript is still feeding the loop. Lead-session only;
// the runtime executor rejects agent-worker callers.
export const SESSION_MANAGE_TOOL = {
  name: 'session_manage',
  title: 'Session Manage',
  annotations: {
    title: 'Session Manage',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
    agentHidden: true,
  },
  description: 'Reset this conversation on explicit user request. action=clear wipes all context (like /clear); action=compact_clear summarizes first and carries context forward (auto-clear style). Applies when the current turn ends.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['clear', 'compact_clear'], description: 'clear = full wipe; compact_clear = summarize then reset.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export const LEAD_DISALLOWED_TOOLS = Object.freeze([]);
export const AGENT_HIDDEN_WRAPPER_TOOLS = new Set([]);

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
