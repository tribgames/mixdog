const DEFAULT_SUMMARY_MAX = 160;
const STATUS_SEPARATOR = ' · ';

export function stripToolPrefix(name) {
  return String(name || 'tool')
    .replace(/^mcp__.*__/, '')
    .replace(/^functions\./, '');
}

export function normalizeToolName(name) {
  return stripToolPrefix(name).replace(/-/g, '_').toLowerCase();
}

export function truncateToolText(value, max = DEFAULT_SUMMARY_MAX) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function truncateSingleLine(value, max = DEFAULT_SUMMARY_MAX) {
  return truncateToolText(String(value ?? '').replace(/\s+/g, ' '), max);
}

function truncateCommand(value, max = DEFAULT_SUMMARY_MAX) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const lines = text.split('\n');
  let out = lines.length > 2 ? `${lines.slice(0, 2).join(' ')}...` : lines.join(' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, Math.max(1, max - 3))}...` : out;
}

export function parseToolArgs(args) {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' ? parsed : { value: args };
    } catch {
      return { value: args };
    }
  }
  if (typeof args === 'object') {
    if (args.input && typeof args.input === 'object') return args.input;
    return args;
  }
  return { value: args };
}

export function displayToolPath(path) {
  const text = String(path ?? '');
  return text.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || text;
}

function compactParts(parts) {
  return parts.filter((part) => part != null && String(part).trim()).map((part) => String(part).trim()).join(STATUS_SEPARATOR);
}

function compactSlash(left, right) {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  return a && b ? `${a}/${b}` : a || b;
}

function quoted(value, max) {
  const text = truncateToolText(value || '', max);
  return text ? `"${text}"` : '';
}

function firstText(...values) {
  for (const value of values) {
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function titleizeToolName(name) {
  return stripToolPrefix(name)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'ui') return 'UI';
      if (lower === 'mcp') return 'MCP';
      if (lower === 'id') return 'ID';
      return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join(' ') || 'Tool';
}

function summarizeLineWindow(a) {
  const offset = a.offset ?? a.start_line ?? a.startLine ?? a.line;
  const limit = a.limit ?? a.line_count ?? a.lineCount ?? a.lines;
  if (offset == null && limit == null) return '';
  const start = Number(offset);
  const count = Number(limit);
  if (Number.isFinite(start) && Number.isFinite(count) && count > 0) {
    return `lines ${start}-${Math.max(start, start + count - 1)}`;
  }
  if (Number.isFinite(start)) return `from line ${start}`;
  if (Number.isFinite(count)) return `${count} lines`;
  return '';
}

function summarizePatch(patch, basePath) {
  const text = String(patch ?? '');
  const files = [];
  for (const line of text.split('\n')) {
    const match = /^\*\*\*\s+(?:Update|Add|Delete) File:\s+(.+)\s*$/.exec(line);
    if (match) files.push(displayToolPath(match[1]));
  }
  if (files.length === 1) return files[0];
  if (files.length > 1) return `${files.length} files`;
  if (basePath) return displayToolPath(basePath);
  return text ? 'patch' : '';
}

function codeGraphLabel(args) {
  const mode = String(args.mode || args.action || '').toLowerCase();
  if (mode === 'prewarm' || mode === 'index' || mode === 'build' || mode === 'refresh') return 'Setup';
  if (mode === 'search' || mode === 'find_symbol' || mode === 'references' || mode === 'callers' || mode === 'callees') return 'Search';
  return 'Read';
}

function codeGraphSummary(args, max) {
  return compactParts([
    args.mode || args.action || '',
    truncateToolText(firstText(args.symbol, Array.isArray(args.symbols) ? args.symbols.join(', ') : '', args.file, args.path, args.query), max),
  ]);
}

export function displayToolName(name, args = {}) {
  const normalized = normalizeToolName(name);
  switch (normalized) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource':
      return 'Read';
    case 'write':
      return 'Write';
    case 'edit':
    case 'apply_patch': {
      const parsed = parseToolArgs(args);
      return parsed && parsed.old_string === '' ? 'Create' : 'Update';
    }
    case 'shell':
    case 'bash_session':
    case 'shell_command':
    case 'task':
    case 'trigger_schedule':
      return 'Run';
    case 'grep':
    case 'glob':
    case 'tool_search':
      return 'Search';
    case 'search':
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
    case 'firecrawl_search':
      return 'Web Search';
    case 'explore':
      return 'Explore';
    case 'web_fetch':
    case 'fetch':
    case 'download_attachment':
      return 'Fetch';
    case 'diagnostics':
    case 'open_config':
    case 'provider_status':
    case 'channel_status':
    case 'schedule_status':
    case 'schedule_control':
    case 'reload_config':
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
    case 'task':
      return 'Agent';
    case 'code_graph':
      return codeGraphLabel(parseToolArgs(args));
    case 'reply':
    case 'react':
    case 'edit_message':
    case 'activate_channel_bridge':
    case 'inject_command':
      return 'Channel';
    default:
      return titleizeToolName(name);
  }
}

export function summarizeToolArgs(name, args, { max = DEFAULT_SUMMARY_MAX } = {}) {
  const a = parseToolArgs(args);
  if (!a || typeof a !== 'object') return '';
  switch (normalizeToolName(name)) {
    case 'read':
      if (!a.path && !a.file_path) return '';
      return compactParts([
        displayToolPath(a.path ?? a.file_path),
        a.pages ? `pages ${a.pages}` : summarizeLineWindow(a),
      ]);
    case 'view_image':
      return displayToolPath(a.path || a.file_path || '');
    case 'write':
    case 'edit':
      return displayToolPath(a.path ?? a.file ?? a.file_path ?? '');
    case 'apply_patch':
      return summarizePatch(a.patch, a.base_path);
    case 'shell':
    case 'bash_session':
    case 'shell_command':
      return truncateCommand(a.description || a.command || a.cmd || '', max);
    case 'task':
      return compactParts([a.action || a.type || 'task', a.task_id || '']);
    case 'list':
    case 'ls':
      return compactParts([
        displayToolPath(a.path ?? a.dir ?? a.cwd ?? ''),
        a.head_limit || a.limit ? `${a.head_limit ?? a.limit} entries` : '',
      ]);
    case 'grep':
      if (!a.pattern && !a.query) return '';
      return compactParts([
        `pattern: ${quoted(a.pattern ?? a.query, max)}`,
        a.path ? `path: ${displayToolPath(a.path)}` : '',
        a.glob ? `glob ${a.glob}` : '',
      ]);
    case 'glob':
      if (!a.pattern && !a.glob) return '';
      return compactParts([
        `pattern: ${quoted(a.pattern ?? a.glob, max)}`,
        a.path ? `path: ${displayToolPath(a.path)}` : '',
      ]);
    case 'search':
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
    case 'firecrawl_search':
      return quoted(a.query || a.keywords || '', max);
    case 'explore':
      return truncateSingleLine(firstText(a.query, a.prompt, a.task, a.goal, a.path), Math.min(max, 80));
    case 'tool_search':
      return quoted(firstText(a.query, a.q, a.text), max);
    case 'web_fetch':
    case 'fetch':
      return truncateToolText(a.url || a.uri || '', max);
    case 'download_attachment':
      return displayToolPath(a.filename || a.name || a.url || '');
    case 'read_mcp_resource':
      return truncateToolText(a.uri || '', max);
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return a.server ? `server "${truncateToolText(a.server, max)}"` : 'all servers';
    case 'diagnostics':
      return truncateToolText(a.scope || a.mode || 'runtime', max);
    case 'open_config':
      return truncateToolText(a.section || a.tab || 'config', max);
    case 'provider_status':
      return truncateToolText(a.provider || 'providers', max);
    case 'channel_status':
      return truncateToolText(a.channel || a.name || 'channels', max);
    case 'schedule_status':
    case 'schedule_control':
    case 'trigger_schedule':
      return compactParts([a.action || a.type || 'schedule', a.name || a.id || '']);
    case 'reload_config':
      return truncateToolText(a.scope || 'config', max);
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
    case 'agent':
    case 'task': {
      const bridgeAction = a.type || a.action || a.mode || '';
      const showTarget = !/^(status|read)$/i.test(String(bridgeAction || ''));
      return compactParts([
        a.role || a.name || a.subagent_type || '',
        compactSlash(a.provider, a.model),
        a.preset ? `preset ${a.preset}` : '',
        a.effort ? `effort ${a.effort}` : '',
        a.fast === true ? 'fast' : '',
        bridgeAction,
        showTarget ? (a.tag || a.sessionId || '') : '',
        truncateSingleLine(firstText(a.description, a.prompt, a.message), Math.min(max, 80)),
      ]);
    }
    case 'code_graph':
      return codeGraphSummary(a, max);
    case 'reply':
    case 'react':
    case 'edit_message':
      return truncateToolText(a.channel || a.channelId || a.messageId || a.emoji || '', max);
    case 'activate_channel_bridge':
      return a.active === false ? 'deactivate' : 'activate';
    case 'inject_command':
      return truncateToolText(firstText(a.command, a.text, a.name), max);
    case 'skill':
    case 'skill_execute':
    case 'skill_view':
    case 'skills_list':
    case 'use_skill':
      return truncateToolText(firstText(a.name, a.skill, a.skill_name), max);
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

function pluralize(count, singular, pluralText = `${singular}s`) {
  return count === 1 ? singular : pluralText;
}

function countNonEmptyLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim()).length;
}

/** Heuristic: does the text look like a line-oriented listing rather than prose? */
function looksLineOriented(text) {
  const lines = String(text ?? '').split('\n').filter((line) => line.trim());
  if (lines.length === 0) return false;
  // Prose tends to be a few long sentences; listings are many shorter rows.
  const longLines = lines.filter((line) => line.trim().length > 200).length;
  return longLines === 0;
}

function summarizeUpdateResult(text, args) {
  const changed = [];
  for (const line of String(text ?? '').split('\n')) {
    const ok = /^\s*OK\s+(modify|add|delete|create)\s+(.+?)(?:\s+([±+\-]\S+))?\s*$/i.exec(line);
    if (ok) {
      changed.push({ action: ok[1].toLowerCase(), path: ok[2].trim(), delta: ok[3] || '' });
      continue;
    }
    const edited = /^\s*(Edited|Created|Updated|Wrote):\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/i.exec(line);
    if (edited) {
      changed.push({ action: edited[1].toLowerCase(), path: edited[2].trim(), delta: edited[3] || '' });
    }
  }
  if (changed.length === 1) {
    const item = changed[0];
    const action = item.action === 'delete' ? 'Deleted' : item.action === 'add' || item.action === 'create' || item.action === 'created' ? 'Created' : 'Updated';
    return compactParts([`${action} ${displayToolPath(item.path)}`, item.delta]);
  }
  if (changed.length > 1) {
    const names = changed.slice(0, 2).map((item) => displayToolPath(item.path)).join(', ');
    const extra = changed.length > 2 ? ` +${changed.length - 2} more` : '';
    return `Updated ${changed.length} files - ${names}${extra}`;
  }

  const parsedArgs = parseToolArgs(args);
  const target = parsedArgs.path ?? parsedArgs.file ?? parsedArgs.file_path ?? '';
  if (target) return `Updated ${displayToolPath(target)}`;
  return null;
}

function textBetweenTag(text, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(String(text ?? ''));
  return match ? match[1].trim() : '';
}

function firstAgentResultLine(text) {
  const finalAnswer = textBetweenTag(text, 'final-answer') || textBetweenTag(text, 'result');
  const raw = finalAnswer || text;
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^<\/?(?:final-answer|task-notification|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>$/i.test(trimmed)) continue;
    if (/^(?:bridge job|status|type|target|role|agent|preset|model|effort|fast|limits|session|job|task-id):\s*/i.test(trimmed)) continue;
    if (/^\[[a-z-]+:\s*[^\]]*\]$/i.test(trimmed)) continue;
    return truncateSingleLine(trimmed, 120);
  }
  return '';
}

/**
 * Derive a short semantic one-liner for a completed tool call using only the
 * tool name, parsed args, and the raw result text. Returns null when nothing
 * reliable can be derived, so the caller falls back to the raw result block.
 */
export function summarizeToolResult(name, args, resultText, isError = false) {
  if (isError) return null;
  const text = String(resultText ?? '');
  const trimmed = text.trim();
  const normalized = normalizeToolName(name);

  switch (normalized) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource': {
      if (/^\[image:/i.test(trimmed)) return 'Read image';
      if (!trimmed) return null;
      const n = text.split('\n').length;
      return `Read ${n} ${pluralize(n, 'line')}`;
    }
    case 'write':
    case 'edit':
    case 'apply_patch': {
      const updateSummary = summarizeUpdateResult(text, args);
      if (updateSummary) return updateSummary;
      // Prefer explicit additions/removals hints if the result text states them.
      const add = /(\d+)\s+addition/i.exec(text);
      const rem = /(\d+)\s+removal/i.exec(text);
      if (add || rem) {
        const a = add ? Number(add[1]) : 0;
        const r = rem ? Number(rem[1]) : 0;
        return `Updated - +${a} -${r}`;
      }
      // Else count unified-diff style +/- lines (ignore +++/--- file headers).
      let a = 0;
      let r = 0;
      for (const line of text.split('\n')) {
        if (/^\+\+\+|^---/.test(line)) continue;
        if (/^\+/.test(line)) a += 1;
        else if (/^-/.test(line)) r += 1;
      }
      if (a > 0 || r > 0) return `Updated - +${a} -${r}`;
      return null;
    }
    case 'grep': {
      if (!trimmed || !looksLineOriented(text)) return null;
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `Found ${n} ${pluralize(n, 'match', 'matches')}`;
    }
    case 'glob': {
      if (!trimmed || !looksLineOriented(text)) return null;
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `Found ${n} ${pluralize(n, 'file')}`;
    }
    case 'shell':
    case 'bash_session':
    case 'shell_command': {
      if (!trimmed) return '(no output)';
      const job = /^\[(?:task_id|job):\s*([^\]]+)\]/mi.exec(text);
      const status = /^\[status:\s*([^\]]+)\]/mi.exec(text);
      const exit = /^\[exit:\s*([^\]]+)\]/mi.exec(text);
      if (job || status || exit) {
        return compactParts([
          job ? job[1] : '',
          status ? status[1] : '',
          exit ? `exit ${exit[1]}` : '',
        ]);
      }
      return null;
    }
    case 'code_graph': {
      const match = /(\d+)\s+(references|definitions|symbols|callers|callees|results|matches)/i.exec(text);
      if (match) return `Found ${match[1]} ${match[2].toLowerCase()}`;
      return null;
    }
    case 'web_fetch':
    case 'fetch': {
      // Status: require a status-like context (HTTP NNN, "Status: NNN",
      // or "NNN OK"/"NNN Not Found") rather than any bare 3-digit number.
      const status = /(?:HTTP[\s/]*\d?\.?\d?\s*|status[:\s]+)([1-5]\d{2})\b/i.exec(text)
        || /\b([1-5]\d{2})\s+(?:OK|Not\s+Found|Forbidden|Moved|Found|Created|No\s+Content|Bad\s+Request|Unauthorized|Internal)/.exec(text);
      const size = /\b(\d+(?:\.\d+)?\s?(?:[KMGT]?B|bytes))\b/i.exec(text);
      if (size && status) return `Received ${size[1]} (${status[1]})`;
      if (size) return `Received ${size[1]}`;
      if (status) return `Received (${status[1]})`;
      return null;
    }
    case 'search': {
      const match = /(\d+)\s+results?/i.exec(text);
      if (match) {
        const n = Number(match[1]);
        return `Found ${n} ${pluralize(n, 'result')}`;
      }
      return null;
    }
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
    case 'firecrawl_search': {
      const match = /(\d+)\s+results?/i.exec(text);
      if (match) {
        const n = Number(match[1]);
        return `Found ${n} ${pluralize(n, 'result')}`;
      }
      return trimmed ? firstAgentResultLine(text) || null : null;
    }
    case 'explore': {
      return trimmed ? firstAgentResultLine(text) || null : null;
    }
    case 'bridge':
    case 'agent':
    case 'task': {
      const answerLine = firstAgentResultLine(text);
      if (answerLine) return answerLine;
      const job = /^bridge job:\s*(job_[^\s]+)/mi.exec(text);
      const status = /^status:\s*([^\s(]+)/mi.exec(text);
      const role = /^role:\s*(.+)$/mi.exec(text);
      const preset = /^preset:\s*(.+)$/mi.exec(text);
      const model = /^model:\s*(.+)$/mi.exec(text);
      const limits = /^limits:\s*(.+)$/mi.exec(text);
      const parts = [
        role ? role[1] : '',
        preset ? preset[1] : '',
        model ? model[1] : '',
        status ? status[1] : '',
        limits ? limits[1] : '',
      ].filter(Boolean);
      if (parts.length) return compactParts(parts);
      if (job) return status ? `${job[1]} ${status[1]}` : job[1];
      return null;
    }
    default:
      return null;
  }
}

export function isExplorerSurface(label) {
  return label === 'Read' || label === 'Search';
}

export function isMemorySurface(label) {
  return label === 'Memory';
}

// ── Aggregate tool-card classification & formatting ──────────────

export const CATEGORY_ORDER = [
  'Read', 'Search', 'Web Research', 'Memory', 'Explore',
  'Edit', 'Shell', 'Agent', 'Channel', 'Setup', 'Other',
];

const TOOL_CATEGORY = new Map([
  ['read', 'Read'],
  ['view_image', 'Read'],
  ['read_mcp_resource', 'Read'],
  ['grep', 'Search'],
  ['glob', 'Search'],
  ['list', 'Search'],
  ['ls', 'Search'],
  ['tool_search', 'Search'],
  ['search', 'Web Research'],
  ['web_search', 'Web Research'],
  ['search_query', 'Web Research'],
  ['image_query', 'Web Research'],
  ['web_search_call', 'Web Research'],
  ['firecrawl_search', 'Web Research'],
  ['web_fetch', 'Web Research'],
  ['fetch', 'Web Research'],
  ['download_attachment', 'Web Research'],
  ['recall', 'Memory'],
  ['recall_memory', 'Memory'],
  ['search_memories', 'Memory'],
  ['remember', 'Memory'],
  ['save_memory', 'Memory'],
  ['update_memory', 'Memory'],
  ['memory', 'Memory'],
  ['explore', 'Explore'],
  ['write', 'Edit'],
  ['edit', 'Edit'],
  ['apply_patch', 'Edit'],
  ['bash', 'Shell'],
  ['shell', 'Shell'],
  ['shell_command', 'Shell'],
  ['bash_session', 'Shell'],
  ['job_wait', 'Shell'],
  ['task', 'Agent'],
  ['bridge', 'Agent'],
  ['agent', 'Agent'],
  ['reply', 'Channel'],
  ['react', 'Channel'],
  ['edit_message', 'Channel'],
  ['activate_channel_bridge', 'Channel'],
  ['inject_command', 'Channel'],
  ['diagnostics', 'Setup'],
  ['open_config', 'Setup'],
  ['provider_status', 'Setup'],
  ['channel_status', 'Setup'],
  ['schedule_status', 'Setup'],
  ['schedule_control', 'Setup'],
  ['reload_config', 'Setup'],
  ['list_mcp_resources', 'Setup'],
  ['list_mcp_resource_templates', 'Setup'],
  ['cwd', 'Setup'],
  ['request_user_input', 'Setup'],
  ['update_plan', 'Setup'],
  ['trigger_schedule', 'Setup'],
  ['skill', 'Setup'],
  ['skill_execute', 'Setup'],
  ['skill_view', 'Setup'],
  ['skills_list', 'Setup'],
  ['use_skill', 'Setup'],
]);

/** Return the aggregate category for a tool name + args. */
export function classifyToolCategory(name, args = {}) {
  const normalized = normalizeToolName(name);
  if (normalized === 'code_graph') {
    const mode = String(args.mode || args.action || '').toLowerCase();
    if (mode === 'prewarm' || mode === 'index' || mode === 'build' || mode === 'refresh') return 'Setup';
    return (mode === 'search' || mode === 'find_symbol' || mode === 'references' || mode === 'callers' || mode === 'callees') ? 'Search' : 'Read';
  }
  return TOOL_CATEGORY.get(normalized) || 'Other';
}

const CATEGORY_COPY = new Map([
  ['Read', { active: 'Reading', done: 'Read', noun: 'item' }],
  ['Search', { active: 'Searching', done: 'Searched', noun: 'item' }],
  ['Web Research', { active: 'Researching', done: 'Researched', noun: 'web item' }],
  ['Memory', { active: 'Checking', done: 'Checked', noun: 'memory item' }],
  ['Explore', { active: 'Exploring', done: 'Explored', noun: 'item' }],
  ['Edit', { active: 'Editing', done: 'Edited', noun: 'item' }],
  ['Shell', { active: 'Running', done: 'Ran', noun: 'command' }],
  ['Agent', { active: 'Calling', done: 'Called', noun: 'agent' }],
  ['Channel', { active: 'Sending', done: 'Sent', noun: 'message' }],
  ['Setup', { active: 'Setting up', done: 'Set up', noun: 'item' }],
  ['Other', { active: 'Calling', done: 'Called', noun: 'tool' }],
]);

/** Active gerund for a category (e.g. "Reading" for "Read"). */
export function activeCategoryLabel(category) {
  return CATEGORY_COPY.get(category)?.active || category;
}

function doneCategoryLabel(category) {
  return CATEGORY_COPY.get(category)?.done || category;
}

function categoryNoun(category, count) {
  const copy = CATEGORY_COPY.get(category) || { noun: 'item' };
  return pluralize(count, copy.noun, copy.pluralNoun || `${copy.noun}s`);
}

/**
 * Build a comma-separated header from per-category counts.
 * e.g. "Read 6 items, Searched 5 items, Called 1 agent"
 */
export function formatAggregateHeader(categories, { pending = false, order = null } = {}) {
  const categoryKeys = Object.keys(categories || {});
  const preferred = Array.isArray(order) && order.length ? order : categoryKeys;
  const seen = new Set();
  const ordered = [];
  const add = (cat) => {
    if (!cat || seen.has(cat) || (categories[cat] || 0) <= 0) return;
    seen.add(cat);
    ordered.push(cat);
  };
  for (const cat of preferred) add(cat);
  for (const cat of CATEGORY_ORDER) add(cat);
  for (const cat of Object.keys(categories || {})) add(cat);

  return ordered
    .map((cat) => {
      const count = Number(categories[cat] || 0);
      const label = pending ? activeCategoryLabel(cat) : doneCategoryLabel(cat);
      return `${label} ${count} ${categoryNoun(cat, count)}`;
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

    let match = /^Read\s+(\d+)\s+lines?$/i.exec(text);
    if (match) {
      const metric = addMetric('read_lines', { count: 0, render: (m) => `Read ${m.count} ${pluralize(m.count, 'line')}` });
      metric.count += Number(match[1]);
      continue;
    }

    if (/^Read image$/i.test(text)) {
      const metric = addMetric('read_images', { count: 0, render: (m) => `Read ${m.count} ${pluralize(m.count, 'image')}` });
      metric.count += 1;
      continue;
    }

    match = /^Found\s+(\d+)\s+([a-z]+)$/i.exec(text);
    if (match) {
      const nounRaw = match[2].toLowerCase();
      const singular = nounRaw.endsWith('ies') ? `${nounRaw.slice(0, -3)}y` : nounRaw.endsWith('s') ? nounRaw.slice(0, -1) : nounRaw;
      const plural = nounRaw.endsWith('s') ? nounRaw : `${nounRaw}s`;
      const key = `found_${plural}`;
      const metric = addMetric(key, { count: 0, singular, plural, render: (m) => `Found ${m.count} ${pluralize(m.count, m.singular, m.plural)}` });
      metric.count += Number(match[1]);
      continue;
    }

    match = /^Updated(?:\s+-)?\s+\+(\d+)\s+-(\d+)$/i.exec(text);
    if (match) {
      const metric = addMetric('updated', { added: 0, removed: 0, render: (m) => `Updated +${m.added} -${m.removed}` });
      metric.added += Number(match[1]);
      metric.removed += Number(match[2]);
      continue;
    }

    addExtra(text);
  }

  return order
    .map((item) => item.type === 'metric' ? metrics.get(item.key)?.render(metrics.get(item.key)) : item.text)
    .filter(Boolean)
    .join(', ');
}
