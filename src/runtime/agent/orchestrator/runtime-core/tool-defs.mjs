// Standalone session tool definitions (wrapper tools surfaced by the runtime).
// Pure, self-contained schemas + the agent-hidden default helper; no runtime
// closure dependencies.

// One load_tool for every session, native and bridge, byte for byte: native
// sessions register the named tools; bridge sessions (see tool-bridge.mjs)
// get their definitions back and run them through call_tool. Native request
// bytes must never change, so the bridge adds nothing to this definition.
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
  description: 'Load full schemas for missing deferred tool names/aliases; batch needed names in one call.',
  inputSchema: {
    type: 'object',
    properties: {
      names: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
        description: 'Exact name(s)/aliases.',
      },
    },
    required: ['names'],
    additionalProperties: false,
  },
};

// Fixed tool bridge for non-native providers (see tool-bridge.mjs). The
// description is static so the definition stays byte-stable: it never carries
// catalog names, counts or listings.
export const CALL_TOOL_TOOL = {
  name: 'call_tool',
  title: 'call_tool',
  annotations: {
    title: 'call_tool',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    agentHidden: true,
  },
  description:
    'Run one tool that is available in this session but not directly exposed, with the arguments its schema requires. The call has the same permissions, approvals and result as calling that tool directly.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 256, description: 'Exact tool name.' },
      arguments: { type: 'object', description: 'Arguments for that tool.' },
    },
    required: ['name', 'arguments'],
    additionalProperties: false,
  },
};

// The fixed bridge for non-native providers: the shared load_tool plus call_tool.
export const TOOL_BRIDGE_TOOLS = Object.freeze([TOOL_SEARCH_TOOL, CALL_TOOL_TOOL]);

export const SESSION_TOOL = {
  name: 'session',
  title: 'Session',
  annotations: {
    title: 'Session',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    agentHidden: true,
  },
  trigger: 'Session status, rename the title, compact, fork into a new session, switch Project, worktrees.',
  description:
    'Manage the current session. status shows session id, title, Project and model; rename sets the session title; compact runs after this turn ends; fork copies this conversation into a new session. set-project switches the active Project; list-projects returns the registered projects (name, path); a project name instead of a path → list-projects first, then set-project with the matching path, ask only if several match. path must be an existing directory. A shell-local cd does not change the Project. Worktree actions act on this session’s git worktree only when the user explicitly asks.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'status',
          'rename',
          'compact',
          'fork',
          'set-project',
          'list-projects',
          'favorite',
          'archive',
          'merge-worktree',
          'remove-worktree',
          'list-worktrees',
          'prune-worktrees',
        ],
        description:
          'status (default without path) shows the session; rename sets title; compact schedules a compaction right after this turn; fork creates a new session copying this conversation (returns its sessionId; this session stays current); set-project switches to path; list-projects returns registered projects; favorite/archive set this session’s sidebar flag to value; merge-worktree merges this session’s worktree into the project folder’s checked-out branch, remove-worktree deletes it (returning to the project folder; call again if it reports WORKTREE_REMOVAL_INCOMPLETE); list-worktrees lists every managed worktree and who retains it; prune-worktrees removes clean, merged ones no session retains.',
      },
      title: { type: 'string', description: 'rename: the new session title.' },
      path: { type: 'string', description: 'Existing directory to switch to (implies action=set-project).' },
      compact: { type: 'boolean', description: 'fork: compact the copied conversation.' },
      force: {
        type: 'boolean',
        description: 'remove-worktree: delete even with uncommitted or unmerged work (only when the user says so).',
      },
      value: { type: 'boolean', description: 'favorite/archive: on or off.' },
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
  description:
    'Load or refresh an available skill’s SKILL.md before task actions when its body is missing or needs an update.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact name from available-skills.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

export const LEAD_DISALLOWED_TOOLS = Object.freeze(['get_goal', 'create_goal', 'set_goal_tasks', 'update_goal']);

// The runtime surfaces named tools from each optional tool-def module, never
// "whatever the module exports": a module that grows a tool must be admitted
// here before it can reach a session.
const WEB_SEARCH_RUNTIME_TOOLS = ['web_search', 'web_fetch', 'local_fetch', 'image_fetch'];
const MEMORY_RUNTIME_TOOLS = ['recall', 'memory'];
const CODE_GRAPH_RUNTIME_TOOLS = ['code_graph'];
const BROWSER_RUNTIME_TOOLS = ['browser', 'browser_devtools'];
const COMPUTER_RUNTIME_TOOLS = ['computer'];
const TERMINAL_RUNTIME_TOOLS = ['terminal'];
const OFFICE_RUNTIME_TOOLS = ['office'];
const MEDIA_RUNTIME_TOOLS = ['media'];
const TIDY_RUNTIME_TOOLS = ['tidy'];
const VISUALIZE_RUNTIME_TOOLS = ['visualize'];

const admitted = (tools, names) => (tools || []).filter((tool) => names.includes(tool?.name));

/**
 * Assemble this runtime's tool definitions from the loaded tool-def modules.
 * Pure: callers resolve their own availability flags (skills env gate) and pass the already-built goal/agent tool arrays.
 *
 * - `standaloneTools` is the model-facing set (also the deferred catalog base).
 * - `internalToolDefs` adds the `public: false` web-search tools: reachable
 *   through the internal executor for other tools, never advertised to a model.
 */
export function collectStandaloneToolDefs({
  webSearchToolDefs,
  memoryToolDefs,
  codeGraphToolDefs,
  browserToolDefs = [],
  computerToolDefs = [],
  terminalToolDefs = [],
  officeToolDefs = [],
  mediaToolDefs = [],
  tidyToolDefs = [],
  visualizeToolDefs = [],
  setupToolDefs = [],
  askUserToolDefs = [],
  goalTools = [],
  agentTools = [],
  skillToolEnabled = true,
}) {
  const webSearchRuntimeTools = admitted(webSearchToolDefs?.TOOL_DEFS, WEB_SEARCH_RUNTIME_TOOLS);
  const standaloneTools = [
    TOOL_SEARCH_TOOL,
    ...(skillToolEnabled ? [SKILL_TOOL] : []),
    SESSION_TOOL,
    ...webSearchRuntimeTools.filter((tool) => tool?.public !== false),
    ...admitted(memoryToolDefs?.TOOL_DEFS, MEMORY_RUNTIME_TOOLS),
    ...admitted(codeGraphToolDefs?.CODE_GRAPH_TOOL_DEFS, CODE_GRAPH_RUNTIME_TOOLS),
    ...admitted(browserToolDefs, BROWSER_RUNTIME_TOOLS),
    ...admitted(computerToolDefs, COMPUTER_RUNTIME_TOOLS),
    ...admitted(terminalToolDefs, TERMINAL_RUNTIME_TOOLS),
    ...admitted(officeToolDefs, OFFICE_RUNTIME_TOOLS),
    ...admitted(mediaToolDefs, MEDIA_RUNTIME_TOOLS),
    ...admitted(tidyToolDefs, TIDY_RUNTIME_TOOLS),
    ...admitted(visualizeToolDefs, VISUALIZE_RUNTIME_TOOLS),
    ...setupToolDefs,
    ...askUserToolDefs,
    ...goalTools,
    ...agentTools,
  ];
  return {
    standaloneTools,
    internalToolDefs: [...standaloneTools, ...webSearchRuntimeTools.filter((tool) => tool?.public === false)],
    // Workflow-aware model surface: a session with no delegatable agents
    // must not advertise the agent tool at all — the model calling a
    // schema-visible tool that policy always rejects is a guaranteed error turn
    // (user-reported in Solo). Names derive from the live agent tool defs.
    agentToolNames: new Set(agentTools.map((tool) => String(tool?.name || '')).filter(Boolean)),
  };
}
