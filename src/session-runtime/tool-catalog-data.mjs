export const MEASURED_TOOL_USAGE = Object.freeze({
  read: 710,
  code_graph: 520,
  grep: 500,
  find: 480,
  glob: 460,
  list: 430,
  apply_patch: 400,
  explore: 360,
  agent: 330,
  shell: 81,
  cwd: 2,
  recall: 2,
  search: 2,
  web_fetch: 2,
});
export const MEASURED_TOOL_ORDER = Object.freeze(Object.keys(MEASURED_TOOL_USAGE));

export const DEFERRED_DEFAULT_FULL_TOOLS = Object.freeze([
  'read', 'code_graph', 'grep', 'find', 'glob', 'list', 'explore',
  'apply_patch', 'Skill', 'load_tool',
]);
export const DEFERRED_DEFAULT_READONLY_TOOLS = Object.freeze([
  'read', 'code_graph', 'grep', 'find', 'glob', 'list', 'explore',
  'Skill', 'load_tool',
]);
export const DEFERRED_DEFAULT_LEAD_TOOLS = Object.freeze([
  'read', 'code_graph', 'grep', 'find', 'glob', 'list', 'shell', 'task',
  'explore', 'apply_patch', 'agent', 'recall', 'search', 'web_fetch', 'cwd',
  'session_manage', 'Skill', 'load_tool',
]);

export const READONLY_TOOL_NAMES = new Set([
  'read', 'list', 'grep', 'find', 'glob', 'code_graph', 'search',
  'web_fetch', 'recall', 'memory', 'fetch', 'Skill',
]);

export const DEFERRED_SELECT_ALIASES = {
  filesystem: ['read', 'list', 'grep', 'find', 'glob'],
  search: ['search', 'web_fetch'],
  web: ['web_fetch', 'search'],
  memory: ['memory', 'recall'],
  channels: ['reply', 'fetch'],
  discord: ['reply', 'fetch'],
  explore: ['explore'],
  discovery: ['explore'],
  agent: ['agent'],
  graph: ['code_graph'],
  code: ['code_graph'],
  shell: ['shell', 'task'],
};
