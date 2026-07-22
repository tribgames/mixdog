// ── Facade: tool-surface primitives + result summaries are re-exported from
// their cohesive modules so every existing importer resolves unchanged. This
// file keeps the display-name / arg-summary and aggregate-card clusters.
import {
  DEFAULT_SUMMARY_MAX,
  AGENT_SURFACE_BRIEF_MAX,
  STATUS_SEPARATOR,
  stripToolPrefix,
  parseMcpToolName,
  isMcpToolName,
  isExternalMcpToolName,
  isSelfMcpToolName,
  titleCaseMcpServer,
  normalizeToolName,
  truncateToolText,
  truncateSingleLine,
  truncateCommand,
  parseToolArgs,
  displayToolPath,
  compactParts,
  compactSlash,
  mcpToolTarget,
  quoted,
  firstText,
  splitToolSearchSelection,
  toolSearchDisplayLabel,
  displayToolSearchTarget,
  titleizeToolName,
  displayAgentName,
  displayModelName,
  bridgeAgentModelSummary,
  summarizeLineWindow,
  summarizePatch,
  collectionCount,
  formatCountedUnit,
  patchFileCount,
  codeGraphLabel,
  codeGraphSummary,
  pluralize,
  titleWord,
  titleStatus,
} from './tool-primitives.mjs';
import {
  parseLineDelta,
  formatLineDelta,
  parseUpdateSummary,
  extractErrorCause,
  summarizeToolResult,
  isExplorerSurface,
  summarizeAgentSurfaceBrief,
  isMemorySurface,
} from './tool-result-summary.mjs';

export {
  AGENT_SURFACE_BRIEF_MAX,
  DEFAULT_SUMMARY_MAX,
  STATUS_SEPARATOR,
  stripToolPrefix,
  parseMcpToolName,
  isMcpToolName,
  normalizeToolName,
  truncateToolText,
  parseToolArgs,
  displayToolPath,
  displayModelName,
  extractErrorCause,
  summarizeToolResult,
  isExplorerSurface,
  summarizeAgentSurfaceBrief,
  isMemorySurface,
};

export function displayToolName(name, args = {}) {
  if (isExternalMcpToolName(name)) {
    const mcp = parseMcpToolName(name);
    return `MCP ${titleCaseMcpServer(mcp.server)}`;
  }
  const normalized = normalizeToolName(name);
  switch (normalized) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource':
      return 'Read';
    case 'apply_patch': {
      const parsed = parseToolArgs(args);
      if (parsed && parsed.dry_run === true) return 'Check';
      return parsed && parsed.old_string === '' ? 'Create' : 'Update';
    }
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return 'Run';
    case 'task':
      return 'Task';
    case 'grep':
    case 'find':
    case 'glob':
    case 'list':
    case 'ls':
      return 'Search';
    case 'load_tool':
      return toolSearchDisplayLabel(parseToolArgs(args));
    case 'search':
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
      return 'Web Search';
    case 'explore':
      return 'Explore';
    case 'web_fetch':
    case 'fetch':
      return 'Fetch';
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
    case 'cwd':
      return 'Setup';
    case 'request_user_input':
      return 'Ask User';
    case 'update_plan':
      return 'Plan';
    case 'memory':
    case 'remember':
    case 'save_memory':
    case 'update_memory':
    case 'recall_memory':
    case 'recall':
    case 'search_memories':
      return 'Memory';
    case 'skill':
    case 'skill_execute':
    case 'skill_view':
    case 'skills_list':
    case 'use_skill':
      return 'Skill';
    case 'bridge':
    case 'agent':
      return 'Agent';
    case 'code_graph':
      return codeGraphLabel(parseToolArgs(args));
    case 'reply':
      return 'Channel';
    default:
      return titleizeToolName(name);
  }
}

export function summarizeToolArgs(name, args, { max = DEFAULT_SUMMARY_MAX } = {}) {
  const a = parseToolArgs(args);
  if (!a || typeof a !== 'object') return '';
  const normalized = normalizeToolName(name);
  if (isExternalMcpToolName(name)) {
    const mcp = parseMcpToolName(name);
    return compactParts([
      truncateToolText(mcp.tool, max),
      truncateToolText(firstText(a.query, a.q, a.text, a.prompt, a.path, a.uri, a.name, a.id, a.action), Math.min(max, 80)),
    ]);
  }
  switch (normalized) {
    case 'read':
      if (!a.path && !a.file_path) return '';
      if (Array.isArray(a.path) || Array.isArray(a.file_path)) {
        return formatCountedUnit(collectionCount(a.path, a.file_path), 'file');
      }
      return compactParts([
        displayToolPath(a.path ?? a.file_path),
        a.pages ? `pages ${a.pages}` : summarizeLineWindow(a),
      ]);
    case 'view_image':
      return displayToolPath(a.path || a.file_path || '');
    case 'apply_patch':
      return summarizePatch(a.patch, a.base_path);
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return truncateCommand(a.description || a.command || a.cmd || '', max);
    case 'task':
      return compactParts([a.action || a.type || 'task', a.task_id || '']);
    case 'list':
    case 'ls':
      if (Array.isArray(a.path) || Array.isArray(a.dir) || Array.isArray(a.cwd)) {
        return formatCountedUnit(collectionCount(a.path, a.dir, a.cwd), 'directory', 'directories');
      }
      return compactParts([
        displayToolPath(a.path ?? a.dir ?? a.cwd ?? ''),
        a.head_limit || a.limit ? `${a.head_limit ?? a.limit} entries` : '',
      ]);
    case 'grep':
      if (!a.pattern && !a.query) return '';
      if (Array.isArray(a.pattern) || Array.isArray(a.query)) {
        return formatCountedUnit(collectionCount(a.pattern, a.query), 'pattern');
      }
      return compactParts([
        `pattern: ${quoted(a.pattern ?? a.query, max)}`,
        a.path ? `path: ${displayToolPath(a.path)}` : '',
        a.glob ? `glob ${a.glob}` : '',
      ]);
    case 'glob':
      if (!a.pattern && !a.glob) return '';
      if (Array.isArray(a.pattern) || Array.isArray(a.glob)) {
        return formatCountedUnit(collectionCount(a.pattern, a.glob), 'glob');
      }
      return compactParts([
        `pattern: ${quoted(a.pattern ?? a.glob, max)}`,
        a.path ? `path: ${displayToolPath(a.path)}` : '',
      ]);
    case 'find':
      if (!a.query && !a.fuzzy) return '';
      if (Array.isArray(a.query) || Array.isArray(a.fuzzy)) {
        return formatCountedUnit(collectionCount(a.query, a.fuzzy), 'query', 'queries');
      }
      return compactParts([
        quoted(a.query ?? a.fuzzy, max),
        a.path ? `path: ${displayToolPath(a.path)}` : '',
      ]);
    case 'search':
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
      if (Array.isArray(a.query) || Array.isArray(a.keywords)) {
        return formatCountedUnit(collectionCount(a.query, a.keywords), 'query', 'queries');
      }
      return quoted(a.query || a.keywords || '', max);
    case 'explore':
      if (Array.isArray(a.query) || Array.isArray(a.prompt) || Array.isArray(a.task) || Array.isArray(a.goal)) {
        return formatCountedUnit(collectionCount(a.query, a.prompt, a.task, a.goal), 'query', 'queries');
      }
      return truncateSingleLine(firstText(a.query, a.prompt, a.task, a.goal, a.path), Math.min(max, 80));
    case 'load_tool':
      {
        const selected = [...splitToolSearchSelection(a.names), ...splitToolSearchSelection(a.select)];
        if (selected.length) return truncateToolText(selected.map(displayToolSearchTarget).join(', '), max);
        return quoted(firstText(a.query, a.q, a.text), max);
      }
    case 'web_fetch':
    case 'fetch':
      if (Array.isArray(a.url) || Array.isArray(a.uri)) {
        return formatCountedUnit(collectionCount(a.url, a.uri), 'URL', 'URLs');
      }
      return truncateToolText(a.url || a.uri || '', max);
    case 'read_mcp_resource':
      return truncateToolText(a.uri || '', max);
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return a.server ? `server "${truncateToolText(a.server, max)}"` : 'all servers';
    case 'cwd':
      return truncateToolText(firstText(a.path, a.cwd, a.dir), max);
    case 'memory':
    case 'remember':
    case 'save_memory':
    case 'update_memory':
    case 'recall_memory':
      return compactParts([
        a.action || a.type || a.operation || a.op || 'memory',
        truncateToolText(firstText(a.query, a.summary, a.element, a.key, a.name, a.text, a.value), Math.min(max, 80)),
      ]);
    case 'recall':
    case 'search_memories':
      return compactParts([
        quoted(firstText(a.query, a.text, a.input), max),
        a.limit || a.topK ? `top ${a.limit ?? a.topK}` : '',
      ]);
    case 'bridge':
    case 'agent': {
      const agentModel = bridgeAgentModelSummary(a);
      if (agentModel) return agentModel;
      const bridgeAction = a.type || a.action || a.mode || '';
      const showTarget = !/^(status|read)$/i.test(String(bridgeAction || ''));
      return compactParts([
        bridgeAction,
        showTarget ? (a.tag || a.sessionId || a.task_id || '') : '',
      ]);
    }
    case 'code_graph':
      return codeGraphSummary(a, max);
    case 'reply':
      return truncateToolText(a.channel || a.channelId || a.messageId || a.emoji || '', max);
    case 'skill':
    case 'skill_execute':
    case 'skill_view':
    case 'skills_list':
    case 'use_skill':
      return truncateToolText(firstText(a.name, a.skill, a.skill_name, a.query, a.q, normalized === 'skills_list' ? 'all skills' : ''), max);
    default: {
      const primary = firstText(a.name, a.skill, a.query, a.title, a.path, a.file, a.target, a.id, a.action);
      if (primary) return truncateToolText(primary, Math.min(max, 80));
      // Last resort: compact key=value of at most the first 2 own keys.
      // Never JSON.stringify the whole object.
      const keys = Object.keys(a).slice(0, 2);
      const pairs = keys
        .map((key) => {
          const value = a[key];
          if (value == null || typeof value === 'object') return '';
          const text = truncateToolText(value, 40);
          return text ? `${key}=${text}` : '';
        })
        .filter(Boolean);
      return compactParts(pairs);
    }
  }
}

export function formatToolSurface(name, args, opts = {}) {
  const parsed = parseToolArgs(args);
  return {
    label: displayToolName(name, parsed),
    summary: summarizeToolArgs(name, parsed, opts),
    normalizedName: normalizeToolName(name),
    args: parsed,
  };
}

// ── Aggregate tool-card classification & formatting ──────────────

const CATEGORY_ORDER = [
  'Read', 'Search', 'Load', 'MCP', 'Skill', 'Web Research', 'Memory', 'Explore',
  'Patch', 'Shell', 'Agent', 'Task', 'Schedule', 'Channel', 'Setup', 'Other',
];

const TOOL_CATEGORY = new Map([
  ['read', 'Read'],
  ['view_image', 'Read'],
  ['read_mcp_resource', 'Read'],
  ['grep', 'Search'],
  ['find', 'Search'],
  ['glob', 'Search'],
  ['list', 'Search'],
  ['ls', 'Search'],
  ['load_tool', 'Load'],
  ['search', 'Web Research'],
  ['web_search', 'Web Research'],
  ['search_query', 'Web Research'],
  ['image_query', 'Web Research'],
  ['web_search_call', 'Web Research'],
  ['web_fetch', 'Web Research'],
  ['fetch', 'Web Research'],
  ['recall', 'Memory'],
  ['recall_memory', 'Memory'],
  ['search_memories', 'Memory'],
  ['remember', 'Memory'],
  ['save_memory', 'Memory'],
  ['update_memory', 'Memory'],
  ['memory', 'Memory'],
  ['explore', 'Explore'],
  ['apply_patch', 'Patch'],
  ['bash', 'Shell'],
  ['shell', 'Shell'],
  ['shell_command', 'Shell'],
  ['bash_session', 'Shell'],
  ['job_wait', 'Shell'],
  ['task', 'Task'],
  ['agent', 'Agent'],
  ['reply', 'Channel'],
  ['list_mcp_resources', 'Setup'],
  ['list_mcp_resource_templates', 'Setup'],
  ['cwd', 'Setup'],
  ['request_user_input', 'Setup'],
  ['update_plan', 'Setup'],
  ['skill', 'Skill'],
  ['skill_execute', 'Skill'],
  ['skill_view', 'Skill'],
  ['skills_list', 'Skill'],
  ['use_skill', 'Skill'],
]);

/** Return the aggregate category for a tool name + args. */
export function classifyToolCategory(name, args = {}) {
  if (isExternalMcpToolName(name)) return 'MCP';
  const normalized = normalizeToolName(name);
  if (normalized === 'code_graph') {
    const mode = String(args.mode || args.action || '').toLowerCase();
    if (mode === 'prewarm' || mode === 'index' || mode === 'build' || mode === 'refresh') return 'Setup';
    return (mode === 'search' || mode === 'find_symbol' || mode === 'references' || mode === 'callers' || mode === 'callees') ? 'Search' : 'Read';
  }
  return TOOL_CATEGORY.get(normalized) || 'Other';
}

const CATEGORY_COPY = new Map([
  ['Read', { active: 'Reading', done: 'Read', noun: 'file' }],
  ['Search', { active: 'Searching', done: 'Searched', noun: 'file' }],
  ['Load', { active: 'Loading', done: 'Loaded', noun: 'tool' }],
  ['MCP', { active: 'Using', done: 'Used', noun: 'MCP tool' }],
  ['Skill', { active: 'Loading', done: 'Loaded', noun: 'skill' }],
  ['Web Research', { active: 'Researching', done: 'Researched', noun: 'query', pluralNoun: 'queries' }],
  ['Memory', { active: 'Checking', done: 'Checked', noun: 'memory item' }],
  ['Explore', { active: 'Exploring', done: 'Explored', noun: 'query', pluralNoun: 'queries' }],
  ['Patch', { active: 'Editing', done: 'Edited', noun: 'file' }],
  ['Shell', { active: 'Running', done: 'Ran', noun: 'command' }],
  ['Agent', { active: 'Calling', done: 'Called', noun: 'agent' }],
  ['Task', { active: 'Checking', done: 'Checked', noun: 'task' }],
  ['Schedule', { active: 'Running', done: 'Ran', noun: 'schedule' }],
  ['Channel', { active: 'Sending', done: 'Sent', noun: 'message' }],
  ['Setup', { active: 'Setting up', done: 'Set up', noun: 'item' }],
  ['Other', { active: 'Calling', done: 'Called', noun: 'tool' }],
]);

/** Active gerund for a category (e.g. "Reading" for "Read"). */
function activeCategoryLabel(category) {
  return CATEGORY_COPY.get(category)?.active || category;
}

function doneCategoryLabel(category) {
  return CATEGORY_COPY.get(category)?.done || category;
}

function categoryNoun(category, count) {
  const copy = CATEGORY_COPY.get(category) || { noun: 'item' };
  return pluralize(count, copy.noun, copy.pluralNoun || `${copy.noun}s`);
}

function categoryCopy(category) {
  return CATEGORY_COPY.get(category) || CATEGORY_COPY.get('Other') || { active: 'Calling', done: 'Called', noun: 'tool' };
}

function unitDescriptor(category, overrides = {}) {
  const copy = categoryCopy(category);
  return {
    category,
    active: overrides.active || copy.active,
    done: overrides.done || copy.done,
    noun: overrides.noun || copy.noun || 'item',
    pluralNoun: overrides.pluralNoun || copy.pluralNoun || `${overrides.noun || copy.noun || 'item'}s`,
    count: Math.max(1, Number(overrides.count || 1)),
  };
}

function queryCount(args, ...keys) {
  return collectionCount(...keys.map((key) => args?.[key]));
}

export function toolWorkUnit(name, args = {}, category = '') {
  const a = parseToolArgs(args);
  const normalized = normalizeToolName(name);
  const cat = category || classifyToolCategory(name, a);
  if (isExternalMcpToolName(name)) {
    const mcp = parseMcpToolName(name);
    return unitDescriptor('MCP', {
      count: queryCount(a, 'query', 'q', 'text', 'prompt', 'path', 'uri', 'name', 'id', 'action') || 1,
      noun: `${titleCaseMcpServer(mcp.server)} tool`,
    });
  }
  switch (normalized) {
    case 'read':
      return unitDescriptor('Read', { count: queryCount(a, 'path', 'paths', 'file_path', 'file', 'files') || 1, noun: 'file' });
    case 'view_image':
      return unitDescriptor('Read', { count: queryCount(a, 'path', 'file_path', 'file') || 1, noun: 'image' });
    case 'read_mcp_resource':
      return unitDescriptor('Read', { count: queryCount(a, 'uri', 'uris') || 1, noun: 'resource' });
    case 'apply_patch': {
      const patchText = String(a.patch ?? '');
      const creating = a.old_string === '' || /^\*\*\*\s+Add File:/mi.test(patchText);
      const deleting = (!creating && a.new_string === '' && a.old_string != null)
        || /^\*\*\*\s+Delete File:/mi.test(patchText);
      // A dry_run patch validates the diff WITHOUT writing any file, so the
      // header must not claim "Editing/Edited" (which made a pure validation
      // look like a real edit). Surface it as "Checking/Checked" instead.
      if (a.dry_run === true) {
        return unitDescriptor('Patch', {
          count: patchFileCount(a) || 1,
          active: 'Checking',
          done: 'Checked',
          noun: 'file',
        });
      }
      return unitDescriptor('Patch', {
        count: patchFileCount(a) || 1,
        active: creating ? 'Creating' : deleting ? 'Deleting' : 'Editing',
        done: creating ? 'Created' : deleting ? 'Deleted' : 'Edited',
        noun: 'file',
      });
    }
    case 'grep':
      return unitDescriptor('Search', { count: queryCount(a, 'pattern', 'patterns', 'query') || 1, active: 'Searching', done: 'Searched', noun: 'pattern' });
    case 'glob':
      return unitDescriptor('Search', { count: queryCount(a, 'pattern', 'patterns', 'glob', 'globs') || 1, active: 'Finding', done: 'Found', noun: 'glob' });
    case 'find':
      return unitDescriptor('Search', { count: queryCount(a, 'query', 'queries', 'fuzzy') || 1, active: 'Finding', done: 'Found', noun: 'query', pluralNoun: 'queries' });
    case 'list':
    case 'ls':
      return unitDescriptor('Search', { count: queryCount(a, 'path', 'paths', 'dir', 'dirs', 'cwd') || 1, active: 'Listing', done: 'Listed', noun: 'directory', pluralNoun: 'directories' });
    case 'load_tool': {
      const selected = [...splitToolSearchSelection(a.names), ...splitToolSearchSelection(a.select)];
      if (selected.length) return unitDescriptor('Load', { count: selected.length, noun: 'tool' });
      return unitDescriptor('Load', { count: queryCount(a, 'query', 'q', 'text') || 1, noun: 'query', pluralNoun: 'queries' });
    }
    case 'search':
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
      return unitDescriptor('Web Research', { count: queryCount(a, 'query', 'queries', 'keywords') || 1, noun: 'query', pluralNoun: 'queries' });
    case 'web_fetch':
      return unitDescriptor('Web Research', { count: queryCount(a, 'url', 'urls', 'uri', 'uris') || 1, active: 'Fetching', done: 'Fetched', noun: 'URL', pluralNoun: 'URLs' });
    case 'fetch': {
      const fetchLimit = Number(a.limit ?? a.messages);
      const fetchCount = Number.isFinite(fetchLimit) && fetchLimit > 0
        ? Math.floor(fetchLimit)
        : queryCount(a, 'messages') || 1;
      return unitDescriptor('Web Research', { count: fetchCount, active: 'Fetching', done: 'Fetched', noun: 'message' });
    }
    case 'recall':
    case 'recall_memory':
    case 'search_memories':
      return unitDescriptor('Memory', { count: queryCount(a, 'query', 'queries', 'text', 'input') || 1, noun: 'memory item', pluralNoun: 'memory items' });
    case 'remember':
    case 'save_memory':
    case 'update_memory':
      return unitDescriptor('Memory', { count: queryCount(a, 'entries', 'items', 'memories', 'query', 'text', 'value') || 1, active: 'Writing', done: 'Wrote', noun: 'memory item' });
    case 'memory': {
      const action = String(a.action || '').toLowerCase();
      const op = String(a.op || '').toLowerCase();
      const isMutation = op === 'add' || op === 'edit' || op === 'delete' || op === 'promote' || op === 'dismiss';
      if (isMutation) return unitDescriptor('Memory', { count: queryCount(a, 'entries', 'items', 'memories', 'query', 'text', 'value') || 1, active: 'Writing', done: 'Wrote', noun: 'memory item' });
      return unitDescriptor('Memory', { count: queryCount(a, 'entries', 'items', 'memories', 'query', 'text', 'value') || 1, active: 'Checking', done: 'Checked', noun: 'memory item' });
    }
    case 'explore':
      return unitDescriptor('Explore', { count: queryCount(a, 'query', 'queries', 'prompt', 'task', 'goal') || 1, noun: 'query', pluralNoun: 'queries' });
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return unitDescriptor('Shell', { count: queryCount(a, 'command', 'commands', 'cmd') || 1, noun: 'command' });
    case 'agent':
    case 'bridge':
      return unitDescriptor('Agent', { count: queryCount(a, 'agents', 'roles', 'role', 'tag', 'task_id', 'sessionId') || 1, noun: 'agent' });
    case 'task': {
      const action = String(a.action || '').toLowerCase();
      if (action === 'cancel') return unitDescriptor('Task', { count: queryCount(a, 'task_id', 'task_ids', 'id', 'ids') || 1, active: 'Cancelling', done: 'Cancelled', noun: 'task' });
      return unitDescriptor('Task', { count: queryCount(a, 'task_id', 'task_ids', 'id', 'ids') || 1, noun: 'task' });
    }
    case 'skill':
    case 'skill_execute':
    case 'skill_view':
    case 'skills_list':
    case 'use_skill':
      return unitDescriptor('Skill', { count: queryCount(a, 'name', 'skill', 'skill_name', 'query', 'q') || 1, noun: 'skill' });
    case 'reply':
      return unitDescriptor('Channel', { count: queryCount(a, 'messages', 'messageId', 'text') || 1, noun: 'message' });
    case 'code_graph': {
      const mode = String(a.mode || a.action || '').toLowerCase();
      const searching = mode === 'search' || mode === 'find_symbol' || mode === 'references' || mode === 'callers' || mode === 'callees';
      return unitDescriptor(searching ? 'Search' : 'Read', {
        count: queryCount(a, 'symbols', 'symbol', 'query', 'file', 'path') || 1,
        active: searching ? 'Mapping' : 'Reading',
        done: searching ? 'Mapped' : 'Read',
        noun: searching ? 'symbol' : 'file',
      });
    }
    case 'request_user_input':
      return unitDescriptor('Setup', { active: 'Asking', done: 'Asked', noun: 'user' });
    case 'update_plan':
      return unitDescriptor('Setup', { active: 'Updating', done: 'Updated', noun: 'plan' });
    case 'list_mcp_resources':
      return unitDescriptor('Setup', { active: 'Listing', done: 'Listed', noun: 'MCP resource' });
    case 'list_mcp_resource_templates':
      return unitDescriptor('Setup', { active: 'Listing', done: 'Listed', noun: 'MCP resource template' });
    case 'cwd': {
      const action = String(a.action || a.type || '').toLowerCase();
      return action === 'set'
        ? unitDescriptor('Setup', { active: 'Setting', done: 'Set', noun: 'working directory', pluralNoun: 'working directories' })
        : unitDescriptor('Setup', { active: 'Checking', done: 'Checked', noun: 'working directory', pluralNoun: 'working directories' });
    }
    default:
      return unitDescriptor(cat, { count: queryCount(a, 'items', 'targets', 'query', 'path', 'name', 'id', 'action') || 1 });
  }
}

function lifecycleVerb(unit, pending, { stableVerbWidth = false } = {}) {
  const active = String(unit.active || '');
  const done = String(unit.done || '');
  const verb = pending ? active : done;
  if (!stableVerbWidth) return verb;
  return verb.padEnd(Math.max(active.length, done.length), ' ');
}

export function formatToolActionHeader(name, args = {}, { pending = false, count = 1, category = '', stableVerbWidth = false } = {}) {
  const unit = toolWorkUnit(name, args, category);
  const n = Math.max(1, Number(unit.count || count || 1));
  const verb = lifecycleVerb(unit, pending, { stableVerbWidth });
  return `${verb} ${n} ${pluralize(n, unit.noun, unit.pluralNoun)}`;
}

export function aggregateToolCategoryEntry(name, args = {}, category = '') {
  const cat = category || classifyToolCategory(name, args);
  const unit = toolWorkUnit(name, args, cat);
  const key = [cat, unit.active, unit.done, unit.noun, unit.pluralNoun].join('|');
  return {
    key,
    category: cat,
    active: unit.active,
    done: unit.done,
    noun: unit.noun,
    pluralNoun: unit.pluralNoun,
    count: Math.max(1, Number(unit.count || 1)),
  };
}

/**
 * Rebuild the per-category count map for the DONE state. Counts ATTEMPTS —
 * failed calls included — so the collapsed header total always agrees with
 * the 'N Ok · N Failed' breakdown rendered beside it ("Ran 5 commands ·
 * 3 Ok · 2 Failed", never "Ran 3 commands · 3 Ok · 2 Failed"). Mirrors the
 * call-time accumulation in turn.mjs (sum aggregateToolCategoryEntry(...).count
 * per key); outcome splitting stays in the failure detail, not the header.
 */
export function aggregateDoneCategories(calls = []) {
  const map = new Map();
  for (const rec of calls || []) {
    if (!rec) continue;
    const entry = aggregateToolCategoryEntry(rec.name, rec.args, rec.category);
    const prev = map.get(entry.key);
    map.set(entry.key, { ...entry, count: Number(prev?.count || 0) + Number(entry.count || 1) });
  }
  return Object.fromEntries(map);
}

function aggregateCount(value) {
  if (value && typeof value === 'object') return Math.max(0, Number(value.count || 0));
  return Math.max(0, Number(value || 0));
}

function aggregateDescriptor(key, value) {
  if (value && typeof value === 'object') {
    const category = value.category || String(key || '').split('|')[0] || 'Other';
    const copy = categoryCopy(category);
    const noun = value.noun || copy.noun || 'item';
    return {
      category,
      active: value.active || copy.active,
      done: value.done || copy.done,
      noun,
      pluralNoun: value.pluralNoun || copy.pluralNoun || `${noun}s`,
      count: aggregateCount(value),
    };
  }
  const category = String(key || '');
  const copy = categoryCopy(category);
  const noun = copy.noun || 'item';
  return {
    category,
    active: copy.active,
    done: copy.done,
    noun,
    pluralNoun: copy.pluralNoun || `${noun}s`,
    count: aggregateCount(value),
  };
}

/**
 * Build a comma-separated header from per-category counts.
 * e.g. "Read 6 items, Searched 5 items, Called 1 agent"
 */
export function formatAggregateHeader(categories, { pending = false, order = null, stableVerbWidth = false } = {}) {
  const categoryKeys = Object.keys(categories || {});
  const preferred = Array.isArray(order) && order.length ? order : categoryKeys;
  const seen = new Set();
  const ordered = [];
  const add = (cat) => {
    if (!cat || seen.has(cat) || aggregateCount(categories[cat]) <= 0) return;
    seen.add(cat);
    ordered.push(cat);
  };
  for (const cat of preferred) add(cat);
  for (const cat of CATEGORY_ORDER) add(cat);
  for (const cat of Object.keys(categories || {})) add(cat);

  return ordered
    .map((cat) => {
      const item = aggregateDescriptor(cat, categories[cat]);
      const label = lifecycleVerb(item, pending, { stableVerbWidth });
      return `${label} ${item.count} ${pluralize(item.count, item.noun, item.pluralNoun)}`;
    })
    .join(', ');
}

/**
 * Join a list of per-call result summaries into a single detail line,
 * deduplicating exact repeats while preserving order.
 */
export function formatAggregateDetail(summaries) {
  if (!summaries || summaries.length === 0) return '';
  const metrics = new Map();
  const order = [];
  const extras = new Set();

  const addMetric = (key, initial) => {
    if (!metrics.has(key)) {
      metrics.set(key, { ...initial });
      order.push({ type: 'metric', key });
      return metrics.get(key);
    }
    return metrics.get(key);
  };

  const addExtra = (text) => {
    if (!text || extras.has(text)) return;
    extras.add(text);
    order.push({ type: 'extra', text });
  };

  for (const raw of summaries) {
    const text = String(raw || '').trim();
    if (!text) continue;

    let match = /^(?:Read\s+)?(\d+)\s+lines?$/i.exec(text);
    if (match) {
      const metric = addMetric('read_lines', { count: 0, render: (m) => `${m.count} ${pluralize(m.count, 'line')}` });
      metric.count += Number(match[1]);
      continue;
    }

    if (/^(?:Read\s+)?image$/i.test(text)) {
      const metric = addMetric('read_images', { count: 0, render: (m) => `${m.count} ${pluralize(m.count, 'image')}` });
      metric.count += 1;
      continue;
    }

    match = /^(?:Found\s+)?(\d+)\s+([a-z]+)$/i.exec(text);
    if (match) {
      const nounRaw = match[2].toLowerCase();
      // Normalize to a canonical singular so singular/plural variants of the
      // SAME noun merge into one metric. Previously "48 matches" keyed as
      // found_matches while "1 match" keyed as found_matchs (naive +s), so the
      // detail row showed "48 matches, 1 match" instead of "49 matches".
      const singular = nounRaw.endsWith('ies') ? `${nounRaw.slice(0, -3)}y`
        : /(?:ch|sh|x|z|s)es$/.test(nounRaw) ? nounRaw.slice(0, -2)
          : nounRaw.endsWith('s') ? nounRaw.slice(0, -1)
            : nounRaw;
      const plural = singular.endsWith('y') ? `${singular.slice(0, -1)}ies`
        : /(?:ch|sh|x|z|s)$/.test(singular) ? `${singular}es`
          : `${singular}s`;
      const key = `found_${singular}`;
      const metric = addMetric(key, { count: 0, singular, plural, render: (m) => `${m.count} ${pluralize(m.count, m.singular, m.plural)}` });
      metric.count += Number(match[1]);
      continue;
    }

    match = /^(?:Updated(?:\s+-)?\s+)?\+(\d+)\s+-(\d+)$/i.exec(text);
    if (match) {
      const metric = addMetric('updated', { added: 0, removed: 0, render: (m) => `+${m.added} -${m.removed}` });
      metric.added += Number(match[1]);
      metric.removed += Number(match[2]);
      continue;
    }

    const update = parseUpdateSummary(text);
    // Dry-run patch checks ("Checked foo.js · +7 -5") are validations, not
    // edits: their line delta must NEVER be summed into the real edit total.
    // They get their own metric so repeated checks still merge; the preview
    // delta is shown only when the card has no real edit delta it could be
    // confused with. Delta-less "Checked ..." texts (task/memory summaries)
    // fall through to extras unchanged.
    if (update && update.action === 'Checked') {
      if (update.seen) {
        const metric = addMetric('checked_files', {
          files: new Set(),
          fileCount: 0,
          added: 0,
          removed: 0,
          seen: false,
          render: (m) => {
            const count = m.fileCount + m.files.size;
            const target = count === 1 && m.fileCount === 0 ? [...m.files][0] : `${count} ${pluralize(count, 'file')}`;
            const editDelta = formatLineDelta(metrics.get('updated_files'));
            const delta = editDelta ? '' : formatLineDelta(m);
            return delta ? `Checked ${target} · ${delta}` : `Checked ${target}`;
          },
        });
        if (update.file) metric.files.add(update.file);
        metric.fileCount += update.fileCount;
        metric.added += update.added;
        metric.removed += update.removed;
        metric.seen = metric.seen || update.seen;
        continue;
      }
    } else if (update) {
      const metric = addMetric('updated_files', {
        files: new Set(),
        fileCount: 0,
        actions: new Set(),
        added: 0,
        removed: 0,
        seen: false,
        render: (m) => {
          // The aggregate header already carries the action + file count
          // (e.g. "Edited 2 files"), so the detail row shows only the merged
          // line delta. Fall back to the action + file/count summary only when
          // there is no +/- delta to show (e.g. pure create/delete).
          const delta = formatLineDelta(m);
          if (delta) return delta;
          const count = m.fileCount + m.files.size;
          const action = m.actions.size === 1 ? [...m.actions][0] : 'Updated';
          const target = count === 1 && m.fileCount === 0 ? [...m.files][0] : `${count} ${pluralize(count, 'file')}`;
          return `${action} ${target}`;
        },
      });
      if (update.file) metric.files.add(update.file);
      metric.fileCount += update.fileCount;
      metric.actions.add(update.action);
      metric.added += update.added;
      metric.removed += update.removed;
      metric.seen = metric.seen || update.seen;
      continue;
    }

    addExtra(text);
  }

  return order
    .map((item) => item.type === 'metric' ? metrics.get(item.key)?.render(metrics.get(item.key)) : item.text)
    .filter(Boolean)
    .join(', ');
}
