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
  description: 'Load full schemas for missing deferred tool names/aliases; batch needed names in one call.',
  inputSchema: {
    type: 'object',
    properties: {
      names: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Exact name(s)/aliases.',
      },
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
  description:
    'Show or switch the working directory (active Project). action=list returns the registered projects (name, path); when the user gives a project name instead of a path, list first, then set with the matching path and ask only if several candidates match. path must be an existing directory. A shell-local cd does not change the Project.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'list'],
        description:
          'get shows the active Project (default without path), set switches to path, list returns registered projects.',
      },
      path: { type: 'string', description: 'Existing directory to switch to (implies action=set).' },
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
    'Load or refresh an available skill’s SKILL.md before task actions when its body is missing or needs an update. Reuse a body already in context for matching requests; a later turn or repeated mention is not a reason to call Skill again.',
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
const OFFICE_RUNTIME_TOOLS = ['office'];
const MEDIA_RUNTIME_TOOLS = ['media'];
const TIDY_RUNTIME_TOOLS = ['tidy'];

const admitted = (tools, names) => (tools || []).filter((tool) => names.includes(tool?.name));

/**
 * Assemble this runtime's tool definitions from the loaded tool-def modules.
 * Pure: callers resolve their own availability flags (skills env gate, channel
 * ownership) and pass the already-built goal/agent tool arrays.
 *
 * - `standaloneTools` is the model-facing set (also the deferred catalog base).
 * - `internalToolDefs` adds the `public: false` web-search tools: reachable
 *   through the internal executor for other tools, never advertised to a model.
 */
export function collectStandaloneToolDefs({
  webSearchToolDefs,
  memoryToolDefs,
  channelToolDefs,
  codeGraphToolDefs,
  browserToolDefs = [],
  computerToolDefs = [],
  officeToolDefs = [],
  mediaToolDefs = [],
  tidyToolDefs = [],
  setupToolDefs = [],
  goalTools = [],
  agentTools = [],
  isChannelTool = () => false,
  skillToolEnabled = true,
}) {
  const webSearchRuntimeTools = admitted(webSearchToolDefs?.TOOL_DEFS, WEB_SEARCH_RUNTIME_TOOLS);
  const standaloneTools = [
    TOOL_SEARCH_TOOL,
    ...(skillToolEnabled ? [SKILL_TOOL] : []),
    CWD_TOOL,
    ...webSearchRuntimeTools.filter((tool) => tool?.public !== false),
    ...admitted(memoryToolDefs?.TOOL_DEFS, MEMORY_RUNTIME_TOOLS),
    ...(channelToolDefs?.TOOL_DEFS || []).filter((tool) => isChannelTool(tool?.name)),
    ...admitted(codeGraphToolDefs?.CODE_GRAPH_TOOL_DEFS, CODE_GRAPH_RUNTIME_TOOLS),
    ...admitted(browserToolDefs, BROWSER_RUNTIME_TOOLS),
    ...admitted(computerToolDefs, COMPUTER_RUNTIME_TOOLS),
    ...admitted(officeToolDefs, OFFICE_RUNTIME_TOOLS),
    ...admitted(mediaToolDefs, MEDIA_RUNTIME_TOOLS),
    ...admitted(tidyToolDefs, TIDY_RUNTIME_TOOLS),
    ...setupToolDefs,
    ...goalTools,
    ...agentTools,
  ];
  return {
    standaloneTools,
    internalToolDefs: [...standaloneTools, ...webSearchRuntimeTools.filter((tool) => tool?.public === false)],
    // Workflow-aware model surface: a pack that declares an EMPTY agents list
    // (Solo) must not advertise the agent tool at all — the model calling a
    // schema-visible tool that policy always rejects is a guaranteed error turn
    // (user-reported in Solo). Names derive from the live agent tool defs.
    agentToolNames: new Set(agentTools.map((tool) => String(tool?.name || '')).filter(Boolean)),
  };
}
