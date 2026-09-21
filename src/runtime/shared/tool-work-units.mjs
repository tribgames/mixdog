// ── Aggregate tool-card classification: which category a tool call belongs
// to, and the "work unit" (verb pair + counted noun) its header is built from.
import {
  parseMcpToolName,
  isExternalMcpToolName,
  titleCaseMcpServer,
  normalizeToolName,
  parseToolArgs,
  splitToolSearchSelection,
  collectionCount,
  patchFileCount,
  codeGraphLabel,
} from './tool-primitives.mjs';

export const CATEGORY_ORDER = [
  'Read',
  'Search',
  'Load',
  'MCP',
  'Skill',
  'Web Research',
  'Memory',
  'Patch',
  'Git',
  'Shell',
  'Agent',
  'Task',
  'Setup',
  'Browser',
  'Computer',
  'Office',
  'Media',
  'Tidy',
  'Other',
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
  ['apply_patch', 'Patch'],
  ['edit', 'Patch'],
  ['strreplace', 'Patch'],
  ['str_replace', 'Patch'],
  ['str_replace_editor', 'Patch'],
  ['search_replace', 'Patch'],
  ['git', 'Git'],
  ['git_stage', 'Git'],
  ['github', 'Git'],
  ['bash', 'Shell'],
  ['shell', 'Shell'],
  ['shell_command', 'Shell'],
  ['bash_session', 'Shell'],
  ['job_wait', 'Shell'],
  ['task', 'Task'],
  ['agent', 'Agent'],
  ['bridge', 'Agent'],
  ['browser', 'Browser'],
  ['browser_devtools', 'Browser'],
  ['computer', 'Computer'],
  ['office', 'Office'],
  ['media', 'Media'],
  ['tidy', 'Tidy'],
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
  if (normalized === 'code_graph') return codeGraphLabel(args);
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
  ['Patch', { active: 'Editing', done: 'Edited', noun: 'file' }],
  ['Git', { active: 'Running', done: 'Ran', noun: 'Git command' }],
  ['Shell', { active: 'Running', done: 'Ran', noun: 'command' }],
  ['Agent', { active: 'Calling', done: 'Called', noun: 'agent' }],
  ['Task', { active: 'Checking', done: 'Checked', noun: 'task' }],
  ['Setup', { active: 'Setting up', done: 'Set up', noun: 'item' }],
  ['Browser', { active: 'Browsing', done: 'Browsed', noun: 'action' }],
  ['Computer', { active: 'Operating', done: 'Operated', noun: 'action' }],
  ['Office', { active: 'Editing', done: 'Edited', noun: 'document action' }],
  ['Media', { active: 'Generating', done: 'Generated', noun: 'media action' }],
  ['Tidy', { active: 'Tidying', done: 'Tidied', noun: 'cleanup pass' }],
  ['Other', { active: 'Calling', done: 'Called', noun: 'tool' }],
]);

export function categoryCopy(category) {
  return (
    CATEGORY_COPY.get(category) || CATEGORY_COPY.get('Other') || { active: 'Calling', done: 'Called', noun: 'tool' }
  );
}

export function unitDescriptor(category, overrides = {}) {
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

/** Per-kind (add/update/delete) file counts read off a patch payload. */
export function patchOperationProfile(args = {}) {
  const a = parseToolArgs(args);
  const patchText = String(a.patch ?? '');
  const counts = new Map();
  const add = (kind, count = 1) => {
    counts.set(kind, Number(counts.get(kind) || 0) + Math.max(1, Number(count || 1)));
  };

  for (const line of patchText.split('\n')) {
    const match = /^\*\*\*\s+(Update|Add|Delete) File:\s+.+\s*$/i.exec(line);
    if (!match) continue;
    add(match[1].toLowerCase());
  }
  if (counts.size > 0) return counts;

  const gitSections = patchText.split(/(?=^diff --git )/m).filter((section) => /^diff --git /m.test(section));
  let unifiedSections = gitSections;
  if (!unifiedSections.length) unifiedSections = /^---\s+.+\n\+\+\+\s+.+$/m.test(patchText) ? [patchText] : [];
  for (const section of unifiedSections) {
    if (/^new file mode /m.test(section) || /^---\s+\/dev\/null(?:\s|$)/m.test(section)) add('add');
    else if (/^deleted file mode /m.test(section) || /^\+\+\+\s+\/dev\/null(?:\s|$)/m.test(section)) add('delete');
    else add('update');
  }
  if (counts.size > 0) return counts;

  if (a.old_string === '') add('add');
  else if (a.new_string === '' && a.old_string != null) add('delete');
  else add('update', patchFileCount(a) || 1);
  return counts;
}

export function patchMutationUnits(args = {}) {
  const a = parseToolArgs(args);
  if (a.dry_run === true) {
    return [
      unitDescriptor('Patch', {
        count: patchFileCount(a) || 1,
        active: 'Checking',
        done: 'Checked',
        noun: 'file',
      }),
    ];
  }
  const copy = {
    add: { active: 'Creating', done: 'Created' },
    delete: { active: 'Deleting', done: 'Deleted' },
    update: { active: 'Editing', done: 'Edited' },
  };
  return [...patchOperationProfile(a)].map(([kind, count]) =>
    unitDescriptor('Patch', {
      count,
      active: copy[kind]?.active || 'Editing',
      done: copy[kind]?.done || 'Edited',
      noun: 'file',
    })
  );
}

// ── Per-tool work units ──────────────────────────────────────────

function applyPatchUnit(a) {
  const units = patchMutationUnits(a);
  if (units.length === 1) return units[0];
  return unitDescriptor('Patch', {
    count: units.reduce((total, unit) => total + unit.count, 0),
    active: 'Changing',
    done: 'Changed',
    noun: 'file',
  });
}

function listUnit(a) {
  return unitDescriptor('Search', {
    count: queryCount(a, 'path', 'paths', 'dir', 'dirs', 'cwd') || 1,
    active: 'Listing',
    done: 'Listed',
    noun: 'directory',
    pluralNoun: 'directories',
  });
}

function loadToolUnit(a) {
  const selected = [...splitToolSearchSelection(a.names), ...splitToolSearchSelection(a.select)];
  if (selected.length) return unitDescriptor('Load', { count: selected.length, noun: 'tool' });
  return unitDescriptor('Load', {
    count: queryCount(a, 'query', 'q', 'text') || 1,
    noun: 'query',
    pluralNoun: 'queries',
  });
}

function webSearchUnit(a) {
  return unitDescriptor('Web Research', {
    count: queryCount(a, 'query', 'queries', 'keywords') || 1,
    noun: 'query',
    pluralNoun: 'queries',
  });
}

function mediaUnit(a) {
  if (a.action !== 'generate') {
    return unitDescriptor('Media', { count: 1, active: 'Checking', done: 'Checked', noun: 'media action' });
  }
  const noun = a.kind === 'video' ? 'video' : 'image';
  return unitDescriptor('Media', { count: 1, active: 'Generating', done: 'Generated', noun });
}

function tidyUnit(a) {
  return a.action === 'fix'
    ? unitDescriptor('Tidy', { count: 1, active: 'Tidying', done: 'Tidied', noun: 'cleanup pass' })
    : unitDescriptor('Tidy', { count: 1, active: 'Checking', done: 'Checked', noun: 'cleanup action' });
}

function fetchUnit(a) {
  const fetchLimit = Number(a.limit ?? a.messages);
  const fetchCount =
    Number.isFinite(fetchLimit) && fetchLimit > 0 ? Math.floor(fetchLimit) : queryCount(a, 'messages') || 1;
  return unitDescriptor('Web Research', {
    count: fetchCount,
    active: 'Fetching',
    done: 'Fetched',
    noun: 'message',
  });
}

function memoryReadUnit(a) {
  return unitDescriptor('Memory', {
    count: queryCount(a, 'query', 'queries', 'text', 'input') || 1,
    noun: 'memory item',
    pluralNoun: 'memory items',
  });
}

function memoryWriteUnit(a) {
  return unitDescriptor('Memory', {
    count: queryCount(a, 'entries', 'items', 'memories', 'query', 'text', 'value') || 1,
    active: 'Writing',
    done: 'Wrote',
    noun: 'memory item',
  });
}

function memoryToolUnit(a) {
  const op = String(a.op || '').toLowerCase();
  const isMutation = op === 'add' || op === 'edit' || op === 'delete';
  if (isMutation) return memoryWriteUnit(a);
  return unitDescriptor('Memory', {
    count: queryCount(a, 'entries', 'items', 'memories', 'query', 'text', 'value') || 1,
    active: 'Checking',
    done: 'Checked',
    noun: 'memory item',
  });
}

function shellUnit(a) {
  return unitDescriptor('Shell', { count: queryCount(a, 'command', 'commands', 'cmd') || 1, noun: 'command' });
}

function agentUnit(a) {
  const type = String(a.type || a.action || '').toLowerCase();
  const status = String(a.status || '').toLowerCase();
  const count = queryCount(a, 'agents', 'roles', 'role', 'tag', 'task_id', 'sessionId') || 1;
  if (type === 'result') {
    if (/^(?:failed|error|timeout|killed|denied)$/.test(status)) {
      return unitDescriptor('Agent', { count, active: 'Finishing', done: 'Failed', noun: 'agent' });
    }
    if (/^(?:cancelled|canceled)$/.test(status)) {
      return unitDescriptor('Agent', { count, active: 'Finishing', done: 'Cancelled', noun: 'agent' });
    }
    return unitDescriptor('Agent', { count, active: 'Finishing', done: 'Completed', noun: 'agent' });
  }
  return unitDescriptor('Agent', { count, noun: 'agent' });
}

function taskUnit(a) {
  const action = String(a.action || '').toLowerCase();
  const taskCount = queryCount(a, 'task_id', 'task_ids', 'id', 'ids') || 1;
  // Waiting on a task, enumerating tasks, and cancelling one are distinct
  // work; only `read`/`status` falls through to the neutral check verb.
  if (action === 'cancel')
    return unitDescriptor('Task', { count: taskCount, active: 'Cancelling', done: 'Cancelled', noun: 'task' });
  if (action === 'wait')
    return unitDescriptor('Task', { count: taskCount, active: 'Waiting for', done: 'Waited for', noun: 'task' });
  if (action === 'list')
    return unitDescriptor('Task', { count: taskCount, active: 'Listing', done: 'Listed', noun: 'task' });
  return unitDescriptor('Task', { count: taskCount, noun: 'task' });
}

function skillUnit(a) {
  return unitDescriptor('Skill', {
    count: queryCount(a, 'name', 'skill', 'skill_name', 'query', 'q') || 1,
    noun: 'skill',
  });
}

function codeGraphUnit(a) {
  const mode = String(a.mode || a.action || '').toLowerCase();
  const searching =
    mode === 'search' || mode === 'find_symbol' || mode === 'references' || mode === 'callers' || mode === 'callees';
  return unitDescriptor(searching ? 'Search' : 'Read', {
    count: queryCount(a, 'symbols', 'symbol', 'query', 'files', 'file', 'path') || 1,
    active: searching ? 'Mapping' : 'Reading',
    done: searching ? 'Mapped' : 'Read',
    // "code map", not "file": an overview/imports/impact pass reads
    // structure, and sharing the plain read unit hid it behind file reads.
    noun: searching ? 'symbol' : 'code map',
  });
}

function cwdUnit(a) {
  const action = String(a.action || a.type || '').toLowerCase();
  const verbs = action === 'set' ? { active: 'Setting', done: 'Set' } : { active: 'Checking', done: 'Checked' };
  return unitDescriptor('Setup', { ...verbs, noun: 'working directory', pluralNoun: 'working directories' });
}

const TOOL_UNITS = new Map([
  [
    'read',
    (a) =>
      unitDescriptor('Read', {
        count: queryCount(a, 'path', 'paths', 'file_path', 'file', 'files') || 1,
        noun: 'file',
      }),
  ],
  [
    'view_image',
    (a) => unitDescriptor('Read', { count: queryCount(a, 'path', 'file_path', 'file') || 1, noun: 'image' }),
  ],
  ['read_mcp_resource', (a) => unitDescriptor('Read', { count: queryCount(a, 'uri', 'uris') || 1, noun: 'resource' })],
  ['apply_patch', applyPatchUnit],
  [
    'grep',
    (a) =>
      unitDescriptor('Search', {
        count: queryCount(a, 'pattern', 'patterns', 'query') || 1,
        active: 'Searching',
        done: 'Searched',
        noun: 'pattern',
      }),
  ],
  [
    'glob',
    (a) =>
      unitDescriptor('Search', {
        count: queryCount(a, 'pattern', 'patterns', 'glob', 'globs') || 1,
        active: 'Finding',
        done: 'Found',
        noun: 'glob',
      }),
  ],
  [
    'find',
    (a) =>
      unitDescriptor('Search', {
        count: queryCount(a, 'query', 'queries', 'fuzzy') || 1,
        active: 'Finding',
        done: 'Found',
        noun: 'query',
        pluralNoun: 'queries',
      }),
  ],
  ['list', listUnit],
  ['ls', listUnit],
  ['load_tool', loadToolUnit],
  ['search_query', webSearchUnit],
  ['image_query', webSearchUnit],
  ['web_search', webSearchUnit],
  ['web_search_call', webSearchUnit],
  [
    'web_fetch',
    (a) =>
      unitDescriptor('Web Research', {
        count: queryCount(a, 'url', 'urls', 'uri', 'uris') || 1,
        active: 'Fetching',
        done: 'Fetched',
        noun: 'URL',
        pluralNoun: 'URLs',
      }),
  ],
  ['browser', () => unitDescriptor('Browser', { count: 1, active: 'Browsing', done: 'Browsed', noun: 'action' })],
  [
    'browser_devtools',
    () => unitDescriptor('Browser', { count: 1, active: 'Browsing', done: 'Browsed', noun: 'action' }),
  ],
  ['computer', () => unitDescriptor('Computer', { count: 1, active: 'Operating', done: 'Operated', noun: 'action' })],
  ['office', () => unitDescriptor('Office', { count: 1, active: 'Editing', done: 'Edited', noun: 'document action' })],
  ['media', mediaUnit],
  ['tidy', tidyUnit],
  ['fetch', fetchUnit],
  ['recall', memoryReadUnit],
  ['recall_memory', memoryReadUnit],
  ['search_memories', memoryReadUnit],
  ['remember', memoryWriteUnit],
  ['save_memory', memoryWriteUnit],
  ['update_memory', memoryWriteUnit],
  ['memory', memoryToolUnit],
  ['shell', shellUnit],
  ['bash', shellUnit],
  ['bash_session', shellUnit],
  ['shell_command', shellUnit],
  ['job_wait', shellUnit],
  [
    'git',
    (a) =>
      a.action === 'stage'
        ? unitDescriptor('Git', {
            count: queryCount(a, 'change_ids', 'change_id') || 1,
            active: 'Staging',
            done: 'Staged',
            noun: 'change',
          })
        : unitDescriptor('Git', { count: queryCount(a, 'command', 'commands') || 1, noun: 'Git command' }),
  ],
  ['github', () => unitDescriptor('Git', { count: 1, noun: 'GitHub operation' })],
  // Preserve the staging work unit when rendering historical transcripts.
  [
    'git_stage',
    (a) =>
      unitDescriptor('Git', {
        count: queryCount(a, 'change_ids', 'change_id') || 1,
        active: 'Staging',
        done: 'Staged',
        noun: 'change',
      }),
  ],
  ['agent', agentUnit],
  ['bridge', agentUnit],
  ['task', taskUnit],
  ['skill', skillUnit],
  ['skill_execute', skillUnit],
  ['skill_view', skillUnit],
  ['skills_list', skillUnit],
  ['use_skill', skillUnit],
  ['code_graph', codeGraphUnit],
  ['request_user_input', () => unitDescriptor('Setup', { active: 'Asking', done: 'Asked', noun: 'user' })],
  ['update_plan', () => unitDescriptor('Setup', { active: 'Updating', done: 'Updated', noun: 'plan' })],
  ['list_mcp_resources', () => unitDescriptor('Setup', { active: 'Listing', done: 'Listed', noun: 'MCP resource' })],
  [
    'list_mcp_resource_templates',
    () => unitDescriptor('Setup', { active: 'Listing', done: 'Listed', noun: 'MCP resource template' }),
  ],
  ['cwd', cwdUnit],
]);

function mcpUnit(name, a) {
  const mcp = parseMcpToolName(name);
  return unitDescriptor('MCP', {
    count: queryCount(a, 'query', 'q', 'text', 'prompt', 'path', 'uri', 'name', 'id', 'action') || 1,
    noun: `${titleCaseMcpServer(mcp.server)} tool`,
  });
}

export function toolWorkUnit(name, args = {}, category = '') {
  const a = parseToolArgs(args);
  if (isExternalMcpToolName(name)) return mcpUnit(name, a);
  const build = TOOL_UNITS.get(normalizeToolName(name));
  if (build) return build(a);
  return unitDescriptor(category || classifyToolCategory(name, a), {
    count: queryCount(a, 'items', 'targets', 'query', 'path', 'name', 'id', 'action') || 1,
  });
}
