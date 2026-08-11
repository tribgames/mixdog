// Canonical route order — the single surface order wherever tools serialize:
// locator → path → content → symbol → read → edit → execute.
export const ROUTE_TOOL_ORDER = Object.freeze([
  'find', 'glob', 'list', 'grep', 'code_graph', 'read',
  'apply_patch', 'shell', 'task',
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
  apply_patch: 400,
  agent: 330,
  shell: 81,
  cwd: 2,
  recall: 2,
  search: 2,
  web_fetch: 2,
});

export const DEFERRED_DEFAULT_FULL_TOOLS = Object.freeze([
  'find', 'glob', 'list', 'grep', 'code_graph', 'read',
  'apply_patch', 'Skill', 'load_tool',
]);
export const DEFERRED_DEFAULT_READONLY_TOOLS = Object.freeze([
  'find', 'glob', 'list', 'grep', 'code_graph', 'read',
  'Skill', 'load_tool',
]);
export const DEFERRED_DEFAULT_LEAD_TOOLS = Object.freeze([
  'find', 'glob', 'list', 'grep', 'code_graph', 'read',
  // cwd / session_manage / web_fetch demoted to the deferred manifest 2026-08:
  // 0 / 0 / 10 calls in a 3-day 7.6k-call trace window; they auto-load on
  // first direct call.
  'apply_patch', 'shell', 'task', 'agent', 'recall', 'search',
  'Skill', 'load_tool',
]);

export const READONLY_TOOL_NAMES = new Set([
  'read', 'list', 'grep', 'find', 'glob', 'code_graph', 'search',
  'web_fetch', 'recall', 'memory', 'Skill',
]);

export const DEFERRED_SELECT_ALIASES = {
  filesystem: ['read', 'list', 'grep', 'find', 'glob'],
  search: ['search', 'web_fetch'],
  web: ['web_fetch', 'search'],
  memory: ['memory', 'recall'],
  agent: ['agent'],
  graph: ['code_graph'],
  code: ['code_graph'],
  shell: ['shell', 'task'],
};
