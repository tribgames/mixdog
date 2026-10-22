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
  description:
    'Load full schemas for missing deferred tool names/aliases; a connector name loads all its tools; batch needed names in one call.',
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
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
    agentHidden: true,
  },
  trigger: 'Session lookup/control, bot status, agent task sessions, title, compact, fork, Project and worktrees.',
  description:
    'Inspect sessions or control another by exact ID, never a guessed one. send acknowledges queue intake, not completion: promise a report of it only when its result has reportsBack: true. create returns status: started — started, not done yet; it reports its final answer, after the agents it started finish, unless its result says reportsBack: false. reportsBack: false carries reportsBackReason, the reason to tell the user. Cancel/delete and worktree actions require the user’s request. Other actions affect only the current session. Pass files on with attachments; a reported turn returns the files it produced as attachments.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'status',
          'list',
          'bots',
          'read',
          'send',
          'cancel',
          'delete',
          'create',
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
          'status defaults to current; list pages sessions, without sub-agent or archived ones unless include_agents/include_archived; bots shows each bot’s activity, work, approvals, routines and attention flags, or with session_id (a bot id or its chat) its routines and recent sessions; read returns latest items; send queues prompt (reportsBack: the turn result reports back here); cancel stops the turn; delete removes the session. create (bot conversations) starts a visible agent task session from brief (started, not done yet); unknown Project: list-projects first, still ambiguous: ask the user. compact runs after this turn; fork copies it without switching. merge-worktree merges into the Project’s checked-out branch; remove-worktree returns to the Project (repeat on WORKTREE_REMOVAL_INCOMPLETE); list-worktrees includes retaining sessions; prune-worktrees removes only clean, merged, unretained worktrees.',
      },
      title: { type: 'string', description: 'rename: new current-session title; create: task title.' },
      session_id: {
        type: 'string',
        description:
          'ID from list; required for read/send/cancel/delete, optional for status/bots. send/cancel/delete cannot target the caller.',
      },
      prompt: { type: 'string', description: 'send: message to enqueue; loads a cold session.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description:
          'list/read: maximum rows, default 25; bots: sessions, default 10. Output: 8KiB per page, 12KiB for initial read tail; follow nextOffset/nextTextOffset for more.',
      },
      cursor: { type: 'string', description: 'list: returned nextCursor.' },
      include_agents: {
        type: 'boolean',
        description: 'list: also sub-agent sessions, default false; your own agents: agent list/status.',
      },
      include_archived: {
        type: 'boolean',
        description: 'list: also archived sessions (archived: true), default false.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description:
          'read: newest items to skip, default 0 (tail). Use nextOffset for older pages; appends/rewinds shift positions.',
      },
      text_offset: {
        type: 'integer',
        minimum: 0,
        description: 'read: UTF-16 text position from nextTextOffset; requires offset, limit:1, item_id.',
      },
      item_id: {
        type: 'string',
        description: 'read: returned item id; rejects a shifted position instead of reading another item.',
      },
      path: {
        type: 'string',
        description:
          'Existing directory; implies set-project. Resolve names with list-projects first. Shell cd does not switch Project.',
      },
      compact: { type: 'boolean', description: 'fork: compact the copy.' },
      force: {
        type: 'boolean',
        description: 'remove-worktree: allow uncommitted/unmerged work only when explicitly requested.',
      },
      value: { type: 'boolean', description: 'favorite/archive: on or off.' },
      brief: { type: 'string', description: 'create: self-contained instruction, the first message.' },
      project: { type: 'string', description: 'create: registered Project name or existing directory.' },
      model: {
        type: 'string',
        description: 'create: provider/model or preset; default is the Lead model (else the last-used one).',
      },
      notify: { type: 'boolean', description: 'create: report results back, default true.' },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 8,
        description:
          'send/create: files the target turn receives as real attachments (images, PDF/Office, text): an attachment of this conversation by its file name (a user upload, e.g. its [Image: source: name]) or id (a reported file’s [attachment:id]), or a file path inside this session’s folders. Secret files are refused.',
      },
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
