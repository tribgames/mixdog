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
  'Terminal',
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
  ['terminal', 'Terminal'],
  ['office', 'Office'],
  ['media', 'Media'],
  ['tidy', 'Tidy'],
  ['list_mcp_resources', 'Setup'],
  ['list_mcp_resource_templates', 'Setup'],
  ['cwd', 'Setup'],
  ['setup', 'Setup'],
  ['goal', 'Setup'],
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
  ['Terminal', { active: 'Reading', done: 'Read', noun: 'terminal output' }],
  ['Office', { active: 'Editing', done: 'Edited', noun: 'document action' }],
  ['Media', { active: 'Generating', done: 'Generated', noun: 'media action' }],
  ['Tidy', { active: 'Tidying', done: 'Tidied', noun: 'cleanup pass' }],
  ['Other', { active: 'Calling', done: 'Called', noun: 'tool' }],
]);

export function categoryCopy(category) {
  return CATEGORY_COPY.get(category) || CATEGORY_COPY.get('Other');
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
    // An effect unit changes state: a failed call must not claim its done verb.
    effect: overrides.effect === true,
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
      effect: true,
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
    effect: true,
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
  if (selected.length) return unitDescriptor('Load', { count: selected.length, noun: 'tool', effect: true });
  return unitDescriptor('Load', {
    count: queryCount(a, 'query', 'q', 'text') || 1,
    noun: 'query',
    pluralNoun: 'queries',
    effect: true,
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
  const action = String(a.action || '').toLowerCase();
  if (action === 'generate') {
    const noun = a.kind === 'video' ? 'video' : 'image';
    return unitDescriptor('Media', { count: 1, active: 'Generating', done: 'Generated', noun, effect: true });
  }
  if (action === 'cancel') {
    return unitDescriptor('Media', {
      count: 1,
      active: 'Cancelling',
      done: 'Cancelled',
      noun: 'media job',
      effect: true,
    });
  }
  if (action === 'list') {
    return unitDescriptor('Media', { count: 1, active: 'Listing', done: 'Listed', noun: 'media catalog' });
  }
  return unitDescriptor('Media', { count: 1, active: 'Checking', done: 'Checked', noun: 'media job' });
}

function tidyUnit(a) {
  const action = String(a.action || '').toLowerCase();
  if (action === 'install') {
    return unitDescriptor('Tidy', {
      count: 1,
      active: 'Installing',
      done: 'Installed',
      noun: 'cleanup engine',
      effect: true,
    });
  }
  if (action === 'fix') {
    // fix writes only with apply:true; otherwise it reports the change plan.
    return a.apply === true
      ? unitDescriptor('Tidy', { count: 1, active: 'Tidying', done: 'Tidied', noun: 'cleanup pass', effect: true })
      : unitDescriptor('Tidy', { count: 1, active: 'Previewing', done: 'Previewed', noun: 'cleanup pass' });
  }
  if (action === 'scan') {
    return unitDescriptor('Tidy', { count: 1, active: 'Scanning', done: 'Scanned', noun: 'project' });
  }
  if (action === 'rules' || action === 'results') {
    return unitDescriptor('Tidy', { count: 1, active: 'Reading', done: 'Read', noun: `cleanup ${action}` });
  }
  return unitDescriptor('Tidy', { count: 1, active: 'Checking', done: 'Checked', noun: 'cleanup action' });
}

// Office actions that only observe or review a document.
const OFFICE_READ_ACTIONS = new Set([
  'snapshot',
  'get',
  'query',
  'describe',
  'detect',
  'issues',
  'qa',
  'validate',
  'render',
  'diff',
  'transactions',
]);
const OFFICE_ACTION_VERBS = new Map([
  ['author', ['Authoring', 'Authored']],
  ['batch', ['Editing', 'Edited']],
  ['create', ['Creating', 'Created']],
  ['attach', ['Attaching', 'Attached']],
  ['open', ['Opening', 'Opened']],
  ['secure', ['Securing', 'Secured']],
  ['begin', ['Starting', 'Started']],
  ['commit', ['Committing', 'Committed']],
  ['rollback', ['Rolling back', 'Rolled back']],
  ['recover', ['Recovering', 'Recovered']],
  ['save', ['Saving', 'Saved']],
  ['finalize', ['Finalizing', 'Finalized']],
  ['close', ['Closing', 'Closed']],
]);

function officeUnit(a) {
  const action = String(a.action || '').toLowerCase();
  if (OFFICE_READ_ACTIONS.has(action)) {
    return unitDescriptor('Office', { count: 1, active: 'Reading', done: 'Read', noun: 'document action' });
  }
  const [active, done] = OFFICE_ACTION_VERBS.get(action) || ['Editing', 'Edited'];
  return unitDescriptor('Office', { count: 1, active, done, noun: 'document action', effect: true });
}

function terminalUnit(a) {
  return String(a.action || '').toLowerCase() === 'list'
    ? unitDescriptor('Terminal', { count: 1, active: 'Listing', done: 'Listed', noun: 'terminal tab' })
    : unitDescriptor('Terminal', { count: 1, active: 'Reading', done: 'Read', noun: 'terminal output' });
}

const GITHUB_VERBS = new Map([
  ['list', ['Listing', 'Listed']],
  ['view', ['Viewing', 'Viewed']],
  ['comments', ['Reading', 'Read']],
  ['logs', ['Reading', 'Read']],
  ['create', ['Creating', 'Created']],
  ['edit', ['Editing', 'Edited']],
  ['close', ['Closing', 'Closed']],
  ['reopen', ['Reopening', 'Reopened']],
  ['comment', ['Commenting on', 'Commented on']],
  ['merge', ['Merging', 'Merged']],
  ['review', ['Reviewing', 'Reviewed']],
  ['checkout', ['Checking out', 'Checked out']],
  ['clone', ['Cloning', 'Cloned']],
  ['fork', ['Forking', 'Forked']],
  ['run', ['Running', 'Ran']],
  ['rerun', ['Rerunning', 'Reran']],
  ['cancel', ['Cancelling', 'Cancelled']],
  ['read', ['Marking read', 'Marked read']],
]);
const GITHUB_READ_VERBS = new Set(['list', 'view', 'comments', 'logs']);

/** `issue.create` → { noun: 'issue', verb: 'create' }; `run.cancel` → run/cancel. */
export function githubActionParts(action) {
  const [noun = '', verb = ''] = String(action || '')
    .toLowerCase()
    .split('.');
  return { noun, verb };
}

function githubUnit(a) {
  const { noun, verb } = githubActionParts(a.action);
  const [active, done] = GITHUB_VERBS.get(verb) || ['Running', 'Ran'];
  if (!noun || !GITHUB_VERBS.has(verb)) {
    return unitDescriptor('Git', { count: 1, noun: 'GitHub operation' });
  }
  const label = noun === 'pr' ? 'PR' : noun;
  return unitDescriptor('Git', {
    count: 1,
    active,
    done,
    noun: label,
    effect: !GITHUB_READ_VERBS.has(verb),
  });
}

function goalUnit(a) {
  const action = String(a.action || '').toLowerCase();
  const verbs = {
    status: ['Checking', 'Checked'],
    create: ['Creating', 'Created'],
    pause: ['Pausing', 'Paused'],
    resume: ['Resuming', 'Resumed'],
    set_tasks: ['Planning', 'Planned'],
    update_tasks: ['Updating', 'Updated'],
    complete: ['Completing', 'Completed'],
    block: ['Blocking', 'Blocked'],
    abandon: ['Abandoning', 'Abandoned'],
  }[action] || ['Updating', 'Updated'];
  return unitDescriptor('Setup', {
    count: 1,
    active: verbs[0],
    done: verbs[1],
    noun: 'goal',
    effect: action !== 'status',
  });
}

const SETUP_VERB_PREFIXES = [
  [/^status$/, ['Checking', 'Checked', false]],
  [/^open$/, ['Opening', 'Opened', false]],
  [/^(?:search|inspect|local_model_details)/, ['Inspecting', 'Inspected', false]],
  [/^(?:install|start)_/, ['Installing', 'Installed', true]],
  [/^(?:add|register|save)_/, ['Adding', 'Added', true]],
  [/^(?:remove|delete|forget)_/, ['Removing', 'Removed', true]],
  [/^cancel_/, ['Cancelling', 'Cancelled', true]],
  [/^(?:reconnect|enable|maintain|update)_/, ['Updating', 'Updated', true]],
];

function setupUnit(a) {
  const action = String(a.action || '').toLowerCase();
  const match = SETUP_VERB_PREFIXES.find(([re]) => re.test(action));
  const [active, done, effect] = match ? match[1] : ['Changing', 'Changed', true];
  return unitDescriptor('Setup', { count: 1, active, done, noun: 'setting', effect });
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
    count: queryCount(a, 'query', 'queries', 'text', 'input', 'id') || 1,
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
    effect: true,
  });
}

function memoryToolUnit(a) {
  const op = String(a.op || a.action || '').toLowerCase();
  if (op === 'delete') {
    return unitDescriptor('Memory', {
      count: queryCount(a, 'id', 'ids') || 1,
      active: 'Deleting',
      done: 'Deleted',
      noun: 'memory item',
      effect: true,
    });
  }
  if (op === 'add' || op === 'edit') return memoryWriteUnit(a);
  return unitDescriptor('Memory', {
    count: queryCount(a, 'entries', 'items', 'memories', 'query', 'text', 'value') || 1,
    active: op === 'list' ? 'Listing' : 'Checking',
    done: op === 'list' ? 'Listed' : 'Checked',
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
  // Checks (status/read/list) observe an agent; they are not calls to it.
  if (/^(?:status|read|list)$/.test(type)) {
    return unitDescriptor('Agent', { count, active: 'Checking', done: 'Checked', noun: 'agent' });
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
    effect: true,
  });
}

function codeGraphUnit(a) {
  const searching = codeGraphLabel(a) === 'Search';
  return unitDescriptor(searching ? 'Search' : 'Read', {
    count: queryCount(a, 'symbols', 'symbol', 'query', 'files', 'file', 'path') || 1,
    active: searching ? 'Mapping' : 'Reading',
    done: searching ? 'Mapped' : 'Read',
    // "code map", not "file": an overview/imports/impact pass reads
    // structure, and sharing the plain read unit hid it behind file reads.
    noun: searching ? 'symbol' : 'code map',
  });
}

function browserUnit() {
  return unitDescriptor('Browser', { count: 1, active: 'Browsing', done: 'Browsed', noun: 'action' });
}

function gitStageUnit(a) {
  return unitDescriptor('Git', {
    count: queryCount(a, 'change_ids', 'change_id') || 1,
    active: 'Staging',
    done: 'Staged',
    noun: 'change',
    effect: true,
  });
}

function cwdUnit(a) {
  const action = String(a.action || a.type || '').toLowerCase();
  // A bare `path` selects that Project even when action is omitted.
  if (action === 'set' || (!action && a.path)) {
    return unitDescriptor('Setup', {
      active: 'Selecting',
      done: 'Selected',
      noun: 'project',
      effect: true,
    });
  }
  if (action === 'list') {
    return unitDescriptor('Setup', { active: 'Listing', done: 'Listed', noun: 'project' });
  }
  return unitDescriptor('Setup', { active: 'Checking', done: 'Checked', noun: 'working directory', pluralNoun: 'working directories' });
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
  ['browser', browserUnit],
  ['browser_devtools', browserUnit],
  ['computer', () => unitDescriptor('Computer', { count: 1, active: 'Operating', done: 'Operated', noun: 'action' })],
  ['terminal', terminalUnit],
  ['office', officeUnit],
  ['goal', goalUnit],
  ['setup', setupUnit],
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
        ? gitStageUnit(a)
        : unitDescriptor('Git', { count: queryCount(a, 'command', 'commands') || 1, noun: 'Git command' }),
  ],
  ['github', githubUnit],
  // Preserve the staging work unit when rendering historical transcripts.
  ['git_stage', gitStageUnit],
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
