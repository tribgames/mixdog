// Canonical route order — the single surface order wherever tools serialize:
// locator → path → content → symbol → read → edit → execute.
export const ROUTE_TOOL_ORDER = Object.freeze([
  'explore',
  'find',
  'glob',
  'list',
  'grep',
  'code_graph',
  'read',
  'edit',
  'apply_patch',
  'git',
  'github',
  'shell',
  'task',
]);

// Measured call counts (3-day trace window); orders the unrouted tail and
// feeds session.deferredToolUsage telemetry.
export const MEASURED_TOOL_USAGE = Object.freeze({
  read: 710,
  code_graph: 520,
  grep: 500,
  find: 480,
  glob: 460,
  list: 430,
  edit: 400,
  apply_patch: 400,
  git: 0,
  agent: 330,
  shell: 81,
  cwd: 2,
  recall: 2,
  web_search: 2,
  web_fetch: 2,
});

export const DEFERRED_DEFAULT_FULL_TOOLS = Object.freeze([
  'find',
  'glob',
  'list',
  'grep',
  'code_graph',
  'read',
  'edit',
  'apply_patch',
  'Skill',
  'load_tool',
]);
export const DEFERRED_DEFAULT_READONLY_TOOLS = Object.freeze([
  'find',
  'glob',
  'list',
  'grep',
  'code_graph',
  'read',
  'Skill',
  'load_tool',
]);
export const DEFERRED_DEFAULT_LEAD_TOOLS = Object.freeze([
  // Present only once Explore has a model (builtin-features.mjs).
  'explore',
  'find',
  'glob',
  'list',
  'grep',
  'code_graph',
  'read',
  // cwd / web_fetch demoted to the deferred manifest 2026-08:
  // 0 / 10 calls in a 3-day 7.6k-call trace window. The model loads them
  // with load_tool; a direct call anyway is absorbed by the runtime
  // call-through (deferred-call-through.mjs) as a safety net.
  'edit',
  'apply_patch',
  'git',
  'shell',
  'task',
  'agent',
  // Always on the Lead surface (native and bridge alike): a question is an
  // optional move the model skips when it costs a load or call_tool hop.
  'ask_user',
  // A bot's reaction, likewise: only a bot's chat with the user has it at all
  // (session-tool-surface.mjs reactionDisabled).
  'react',
  'Skill',
  'load_tool',
]);

export const READONLY_TOOL_NAMES = new Set([
  'read',
  'list',
  'grep',
  'find',
  'glob',
  'code_graph',
  'web_search',
  'web_fetch',
  'recall',
  // memory is not listed: it adds, edits and deletes standing memories.
  'Skill',
]);

export const DEFERRED_SELECT_ALIASES = {
  filesystem: ['read', 'list', 'grep', 'find', 'glob'],
  websearch: ['web_search', 'web_fetch'],
  web: ['web_fetch', 'web_search'],
  memory: ['memory', 'recall'],
  agent: ['agent'],
  graph: ['code_graph'],
  code: ['code_graph'],
  shell: ['shell', 'task'],
  git: ['git'],
  github: ['github'],
};
